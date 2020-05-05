import { Client, PacketReader, PacketWriter, ServerConnection, State, nbt, Position } from "mcproto"
import { reactive, markRaw, toRaw, effect, stop } from "@vue/reactivity"
import * as chat from "mc-chat-format"
import { performance } from "perf_hooks"
import { createGzip, Gzip } from "zlib"
import * as fs from "fs"
import { validateOrRefreshToken } from "./utils"
import { Profile, users } from "./data"
import { sendNotification } from "./notifications"

export async function connect(connections: Map<string, Connection>, profile: Profile, host = "localhost", port = 25566) {
  if (connections.has(profile.id)) throw new Error("Already connected")

  const connection = new Connection(profile)
  connections.set(profile.id, connection)

  connection.client.on("end", () => {
    connections.delete(profile.id)
    if (!connection.userHasDisconnected && profile.settings.autoReconnect.enabled) {
      setTimeout(() => connect(connections, profile, host, port)
        .catch(error => console.error(error)), profile.settings.autoReconnect.delay)
    }
  })

  try {
    if (!await validateOrRefreshToken(profile)) throw new Error("Failed to refresh token")
    await connection.connect(host, port)
  } catch (error) {
    connections.delete(profile.id)
    throw error
  }
  return connection
}

export function disconnect(connections: Map<string, Connection>, profile: Profile) {
  const connection = connections.get(profile.id)
  if (connection) connection.disconnect()
}

export interface PlayerListItem {
  name: string
  gamemode: number
  ping: number
  properties: { name: string, value: string, signature?: string }[]
  displayName?: string
}

export interface Team {
  displayName: string
  prefix: string
  suffix: string
  flags: number
  nameTagVisibility: string
  collisionRule: string
  color: number
  members: Set<string>
}

export interface BossBar {
  title: string
  health: number
  color: number
  division: number
  flags: number
}

export interface MapData {
  scale: number
  showIcons: boolean
  icons: { type: number, direction: number, x: number, y: number }[]
  data: number[]
}

export interface Item {
  id: number
  count: number
  damage: number
  tag: nbt.Tag | null
}

export interface MetadataEntry {
  type: number
  value: any
}

export interface EntityProperty {
  value: number
  modifiers: { uuid: string, amount: number, operation: number }[]
}

export type Metadata = Map<number, MetadataEntry>
export type EntityProperties = Map<string, EntityProperty>

export interface Entity {
  type: "object" | "orb" | "global" | "mob" | "painting" | "player"
  eid: number
  uuid?: string
  objectType?: number
  objectData?: number
  orbCount?: number
  globalEntityType?: number
  mobType?: number
  paintingTitle?: string
  paintingDirection?: number
  x: number
  y: number
  z: number
  pitch?: number
  yaw?: number
  headPitch?: number
  vx?: number
  vy?: number
  vz?: number
  properties?: EntityProperties
  metadata?: Metadata
  equipment?: Map<number, Item>
  passengers?: Set<number>
  attachedEid?: number
}

export interface Player {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
}

export interface ChunkSection {
  blocks: Uint16Array
  blockLight: Buffer
  skyLight?: Buffer
}

export interface BlockEntity {
  [key: string]: any
  x: nbt.Int
  y: nbt.Int
  z: nbt.Int
}

export interface Chunk {
  x: number
  z: number
  sections: (ChunkSection | null)[]
  biomes: Buffer
  blockEntities: BlockEntity[]
}

export interface Queue {
  position: number
  time: string
}

export class ConnectError extends Error {
  constructor(public reason: chat.StringComponent) {
    super(`Failed to connect: ${chat.format(reason)}`)
  }
}

export class Connection {
  // Properties for state tracking
  player: Player = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
  inventory = new Map<number, Item>()

  players = new Map<string, PlayerListItem>()
  teams = new Map<string, Team>()
  bossBars = new Map<string, BossBar>()
  maps = new Map<number, MapData>()
  unlockedRecipes = new Set<number>()

  chunks = new Map<number, Map<number, Chunk>>()
  entities = new Map<number, Entity>()

  eid = -1
  gamemode = 0
  dimension = 0
  difficulty = 0
  levelType = "default"

  health = 20
  food = 20
  saturation = 5
  healthInitialized = false

  xpBar = 0
  level = 0
  totalXp = 0

  playerListHeader?: chat.Component
  playerListFooter?: chat.Component

  invulnerable = false
  flying = false
  allowFlying = false
  creativeMode = false
  flyingSpeed = 0.05
  fov = 0.1

  worldAge = BigInt(0)
  time = BigInt(0)
  spawnPosition: Position = { x: 0, y: 0, z: 0 }

  heldItem = 0
  raining = false
  fadeValue = 0
  fadeTime = 0

  camera: number | null = null
  ridingEid: number | null = null

  // Connection related properties
  client: Client
  uuid?: string
  username?: string

  conn: ServerConnection | null = null
  disconnectReason?: chat.StringComponent
  userHasDisconnected = false

  chatListeners = new Set<(message: chat.StringComponent) => void>()
  lastChatMessages: chat.StringComponent[] = []

  queue: Queue | null = null
  dumpStream?: Gzip

  constructor(public profile: Profile) {
    this.client = markRaw(new Client({ profile: profile.id, accessToken: profile.accessToken }))
    this.proxy = this.proxy.bind(this)
    this.mapServerboundPacket = this.mapServerboundPacket.bind(reactive(this))
    this.track = this.track.bind(reactive(this))
  }

  async connect(host: string, port?: number) {
    await this.client.connect(host, port)

    this.client.send(new PacketWriter(0x0).writeVarInt(340)
      .writeString(host).writeUInt16(this.client.socket.remotePort!)
      .writeVarInt(State.Login))

    this.client.send(new PacketWriter(0x0).writeString(this.profile.name))

    let disconnectReason: chat.StringComponent | undefined
    const disconnectListener = this.client.onPacket(0x0, packet => {
      disconnectReason = chat.convert(packet.readJSON())
      this.client.end()
    })

    let packet!: PacketReader
    try {
      packet = await this.client.nextPacket(0x2, false)
      disconnectListener.dispose()
    } catch (error) {
      if (disconnectReason) throw new ConnectError(disconnectReason)
      else throw error
    }

    this.uuid = packet.readString().replace(/-/g, "")
    this.username = packet.readString()
    this.initialize()
  }

  private initialize() {
    const interval = setInterval(() => {
      if (this.dumpStream) this.dumpStream.flush()
    }, 30000)

    this.client.on("packet", packet => {
      if (packet.id != 0x1f) this.dumpPacket(packet.buffer, false)
    })

    this.client.on("end", () => clearInterval(interval))
    this.client.onPacket(0x1a, packet => {
      this.disconnectReason = chat.convert(packet.readJSON())
      this.client.end()
    })

    this.track()
    if (this.profile.settings.enablePacketDumps) this.startDump()
  }

  dumpPacket(buffer: Buffer, serverbound = false, time = performance.now()) {
    if (!this.dumpStream) return
    const header = Buffer.alloc(13)
    header.writeUInt32BE(buffer.length, 0)
    header.writeInt8(+serverbound, 4)
    header.writeDoubleBE(performance.timeOrigin + time, 5)
    this.dumpStream.write(Buffer.concat([header, buffer]))
  }

  startDump() {
    if (!fs.existsSync("dumps")) fs.mkdirSync("dumps")
    const file = fs.createWriteStream(`dumps/${new Date().toISOString()}.${this.profile.id}.dump.gz`)
    this.dumpStream = createGzip({ level: 4 })
    this.dumpStream.on("close", () => delete this.dumpStream)
    this.dumpStream.pipe(file, { end: true })
  }

  stopDump() {
    this.dumpStream?.end()
    delete this.dumpStream
  }

  disconnect() {
    this.userHasDisconnected = true
    return this.client.end()
  }

  async proxy(conn: ServerConnection, eid = this.eid, uuid: string, respawn = false) {
    if (this.conn) throw new Error("Already proxied")
    reactive(this).conn = conn

    if (this.eid == -1) await this.client.nextPacket(0x23, false)
    if (eid == -1) eid = this.eid

    for (const packet of this.getPackets(respawn, eid)) {
      await conn.send(this.mapClientboundPacket(new PacketReader(packet.encode()), eid))
    }

    const gamemodeEffect = effect(() => conn.send(new PacketWriter(0x2e)
      .writeVarInt(1).writeVarInt(1)
      .write(Buffer.from(uuid, "hex"))
      .writeVarInt(reactive(this).gamemode)))

    const serverboundListener = conn.on("packet", packet => {
      // ignore teleport confirm and keep alive packet
      if (packet.id == 0x0 || packet.id == 0xb) return
      const buffer = this.mapServerboundPacket(packet, eid)
      this.client.send(buffer)
      this.dumpPacket(buffer, true)
    })

    const clientboundListener = this.client.on("packet", packet => {
      try {
        conn.send(this.mapClientboundPacket(packet, eid))
      } catch (error) {
        console.error(error)
        conn.end()
      }
    })
    const endListener = this.client.on("end", () => conn.end())

    const unproxy = () => {
      stop(gamemodeEffect)
      serverboundListener.dispose()
      clientboundListener.dispose()
      endListener.dispose()
      reactive(this).conn = null
    }

    conn.on("end", unproxy)
    return unproxy
  }

  sendChatMessage(text: string) {
    this.client.send(new PacketWriter(0x2).writeString(text))
  }

  private track() {
    // chat message
    this.client.onPacket(0xf, packet => {
      const message = packet.readJSON()
      const position = packet.readUInt8()
      if (position != 0 && position != 1) return

      if (this.queue && chat.format(message).includes("Connecting to the server")) {
        this.queue = null
      }

      this.chatListeners.forEach(handler => handler(message))
      this.lastChatMessages.push(message)

      if (this.lastChatMessages.length > 100) {
        this.lastChatMessages = this.lastChatMessages.slice(-90)
      }
    })

    // player list header and footer
    this.client.onPacket(0x4a, packet => {
      const text = chat.format(packet.readJSON())
      const match = text.match(/queue: (\d*).+time: ([^\n]+)/s)
      if (match) {
        if (!this.queue) {
          this.queue = { position: +match[1], time: match[2] }
        } else {
          this.queue.position = +match[1]
          this.queue.time = match[2]
        }
      }
    })

    // spawn object
    this.client.onPacket(0x0, packet => {
      const eid = packet.readVarInt()
      this.entities.set(eid, {
        type: "object", eid, uuid: packet.read(16).toString("hex"), objectType: packet.readInt8(),
        x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        pitch: packet.readInt8(), yaw: packet.readInt8(),
        objectData: packet.readInt32(),
        vx: packet.readInt16(), vy: packet.readInt16(), vz: packet.readInt16()
      })
    })

    // spawn experience orb
    this.client.onPacket(0x1, packet => {
      const eid = packet.readVarInt()
      this.entities.set(eid, {
        type: "orb", eid,
        x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        orbCount: packet.readInt16()
      })
    })

    // spawn mob
    this.client.onPacket(0x3, packet => {
      const eid = packet.readVarInt()
      this.entities.set(eid, {
        type: "mob", eid, uuid: packet.read(16).toString("hex"), mobType: packet.readVarInt(),
        x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        yaw: packet.readInt8(), pitch: packet.readInt8(), headPitch: packet.readInt8(),
        vx: packet.readInt16(), vy: packet.readInt16(), vz: packet.readInt16(),
        metadata: readMetadata(packet)
      })
    })

    // spawn painting
    this.client.onPacket(0x4, packet => {
      const eid = packet.readVarInt()
      this.entities.set(eid, {
        type: "painting", eid,
        uuid: packet.read(16).toString("hex"),
        paintingTitle: packet.readString(),
        ...packet.readPosition(),
        paintingDirection: packet.readInt8()
      })
    })

    // spawn player
    this.client.onPacket(0x5, packet => {
      const eid = packet.readVarInt()
      const uuid = packet.read(16).toString("hex")
      this.entities.set(eid, {
        type: "player", eid, uuid,
        x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        yaw: packet.readInt8(), pitch: packet.readInt8(),
        metadata: readMetadata(packet)
      })

      if (this.profile.settings.notifyPlayers.enabled
        && (!this.profile.settings.notifyPlayers.disableWhilePlaying || !this.conn)) {
        const player = this.players.get(uuid)
        if (player && !this.profile.settings.notifyPlayers.ignore.includes(player.name)) {
          for (const user of users.values()) {
            if (user.profiles.has(this.profile.id)) sendNotification(user, {
              title: `${player.name} is in range of ${this.profile.name}`,
              tag: `player-${this.profile.id}`,
              renotify: true
            })
          }
        }
      }
    })

    // update block entity
    this.client.onPacket(0x9, packet => {
      const pos = packet.readPosition()
      packet.readUInt8() // action
      const tag = packet.readNBT()
      const chunk = this.getChunk(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
      if (!chunk) return

      const index = chunk.blockEntities
        .findIndex(block => +block.x == pos.x && +block.y == pos.y && +block.z == pos.z)

      if (index == -1) {
        chunk.blockEntities.push(tag.value as BlockEntity)
      } else {
        chunk.blockEntities[index] = { ...chunk.blockEntities[index], ...tag.value as BlockEntity }
      }
    })

    // block change
    this.client.onPacket(0xb, packet => {
      const pos = packet.readPosition()
      const block = packet.readVarInt()

      const chunk = this.getChunk(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
      if (!chunk) return

      const section = chunk.sections[Math.floor(pos.y / 16)]
      if (!section) return

      section.blocks[mod(pos.y, 16) * 256 + mod(pos.z, 16) * 16 + mod(pos.x, 16)] = block
      if (block == 0) chunk.blockEntities = chunk.blockEntities
        .filter(block => +block.x != pos.x && +block.y != pos.y && +block.z != pos.z)
    })

    // boss bar
    this.client.onPacket(0xc, packet => {
      const uuid = packet.read(16).toString("hex")
      const action = packet.readVarInt()
      if (action == 0) {
        this.bossBars.set(uuid, {
          title: packet.readString(),
          health: packet.readFloat(),
          color: packet.readVarInt(),
          division: packet.readVarInt(),
          flags: packet.readUInt8()
        })
      } else {
        const bossBar = this.bossBars.get(uuid)
        if (!bossBar) return
        if (action == 1) {
          this.bossBars.delete(uuid)
        } else if (action == 2) {
          bossBar.health = packet.readFloat()
        } else if (action == 3) {
          bossBar.title = packet.readString()
        } else if (action == 4) {
          bossBar.color = packet.readVarInt()
          bossBar.division = packet.readVarInt()
        } else if (action == 5) {
          bossBar.flags = packet.readUInt8()
        }
      }
    })

    // server difficulty
    this.client.onPacket(0xd, packet => {
      this.difficulty = packet.readUInt8()
    })

    // multi block change
    this.client.onPacket(0x10, packet => {
      const chunk = this.getChunk(packet.readInt32(), packet.readInt32())
      if (!chunk) return

      for (let i = packet.readVarInt(); i--;) {
        const value = packet.readUInt8()
        const x = value >> 4
        const z = value & 0xf
        const y = packet.readUInt8()
        const block = packet.readVarInt()

        const section = chunk.sections[Math.floor(y / 16)]
        if (!section) return

        section.blocks[mod(y, 16) * 256 + z * 16 + x] = block
        if (block == 0) chunk.blockEntities = chunk.blockEntities
          .filter(block => +block.x != x && +block.y != y && +block.z != z)
      }
    })

    // window items
    this.client.onPacket(0x14, packet => {
      if (packet.readUInt8() != 0) return
      const count = packet.readUInt16()
      for (let i = 0; i < count; i++) {
        const item = readSlot(packet)
        if (!item) this.inventory.delete(i)
        else this.inventory.set(i, item)
      }
    })

    // set slot
    this.client.onPacket(0x16, packet => {
      if (packet.readInt8() != 0) return
      const slot = packet.readInt16()
      const item = readSlot(packet)
      if (!item) this.inventory.delete(slot)
      else this.inventory.set(slot, item)
    })

    // TODO: 0x18 plugin channel

    // explosion
    this.client.onPacket(0x1c, packet => {
      const cx = packet.readFloat() | 0
      const cy = packet.readFloat() | 0
      const cz = packet.readFloat() | 0
      packet.readFloat() // radius

      for (let i = packet.readUInt32(); i--;) {
        const x = cx + packet.readInt8()
        const y = cy + packet.readInt8()
        const z = cz + packet.readInt8()

        const chunk = this.getChunk(Math.floor(x / 16), Math.floor(z / 16))
        if (!chunk) return

        const section = chunk.sections[Math.floor(y / 16)]
        if (!section) return

        section.blocks[mod(y, 16) * 256 + mod(z, 16) * 16 + mod(x, 16)] = 0
        chunk.blockEntities = chunk.blockEntities.filter(block => +block.x != x && +block.y != y && +block.z != z)
      }
    })

    // unload chunk
    this.client.onPacket(0x1d, packet => {
      this.deleteChunk(packet.readInt32(), packet.readInt32())
    })

    // change gamestate
    this.client.onPacket(0x1e, packet => {
      const reason = packet.readUInt8()
      const value = packet.readFloat()
      if (reason == 1) {
        this.raining = false
      } else if (reason == 2) {
        this.raining = true
      } else if (reason == 3) {
        this.gamemode = value
      } else if (reason == 7) {
        this.fadeValue = value
      } else if (reason == 8) {
        this.fadeTime = value
      }
    })


    // chunk data
    this.client.onPacket(0x20, packet => {
      const chunkX = packet.readInt32()
      const chunkZ = packet.readInt32()
      const fullChunk = packet.readBool()
      const sectionBitMask = packet.readVarInt()
      packet.readVarInt() // data size

      const chunk = fullChunk ? this.setChunk(chunkX, chunkZ, {
        x: chunkX, z: chunkZ,
        sections: Array(16).fill(null),
        biomes: Buffer.alloc(0),
        blockEntities: []
      }) : this.getChunk(chunkX, chunkZ)
      if (!chunk) return

      for (let s = 0; s < 16; s++) {
        if ((sectionBitMask & (1 << s)) == 0) continue
        const bitsPerBlock = packet.readUInt8()
        const bitMask = (1 << bitsPerBlock) - 1
        const palette = [...Array(packet.readVarInt())].map(() => packet.readVarInt())
        const data = packet.read(packet.readVarInt() * 8)
        const blocks = new Uint16Array(4096)
        for (let i = 0; i < 4096; i++) {
          const start = (i * bitsPerBlock / 32) | 0
          const end = (((i + 1) * bitsPerBlock - 1) / 32) | 0
          const offset = (i * bitsPerBlock) % 32
          const first = (start - start % 2 * 2 + 1) * 4
          let value = data.readInt32BE(first) >>> offset
          if (start != end) value |= data.readInt32BE((end - end % 2 * 2 + 1) * 4) << (32 - offset)
          value &= bitMask
          blocks[i] = bitsPerBlock > 8 ? value : palette[value]
        }

        const section: ChunkSection = { blocks, blockLight: packet.read(2048) }

        if (this.dimension == 0) section.skyLight = packet.read(2048)
        chunk.sections[s] = section
      }

      if (fullChunk) chunk.biomes = packet.read(256)

      chunk.blockEntities = [...Array(packet.readVarInt())].map(() => {
        return packet.readNBT().value as BlockEntity
      })
    })

    // join game
    this.client.onPacket(0x23, packet => {
      this.eid = packet.readInt32()
      this.gamemode = packet.readUInt8()
      this.dimension = packet.readInt32()
      this.difficulty = packet.readUInt8()
      this.levelType = (packet.readUInt8(), packet.readString())
      this.entities.set(this.eid, { type: "player", eid: this.eid, x: 0, y: 0, z: 0 })
    })

    // map
    this.client.onPacket(0x24, packet => {
      const id = packet.readVarInt()
      const scale = packet.readUInt8()
      const showIcons = packet.readBool()
      const icons = [...Array(packet.readVarInt())].map(() => {
        const value = packet.readUInt8()
        return {
          type: (value & 0xf0) >> 4, direction: value & 0xf,
          x: packet.readUInt8(), y: packet.readUInt8()
        }
      })
      if (!this.maps.has(id)) {
        this.maps.set(id, { scale, showIcons, icons, data: Array(16384).fill(0) })
      }
      const cols = packet.readUInt8()
      if (cols == 0) return
      const rows = packet.readUInt8()
      const x = packet.readUInt8()
      const z = packet.readUInt8()
      const data = packet.read(packet.readVarInt())
      const map = this.maps.get(id)!
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          map.data[(z + r) * 128 + x + c] = data[r * cols + c]
        }
      }
    })

    // entity look and relative move
    this.client.on("packet", packet => {
      if (![0x26, 0x27].includes(packet.id)) return
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.x! += packet.readInt16() / 4096
      entity.y! += packet.readInt16() / 4096
      entity.z! += packet.readInt16() / 4096
      if (packet.id == 0x27) {
        entity.yaw = packet.readInt8()
        entity.pitch = packet.readInt8()
      }
    })

    // entity look
    this.client.onPacket(0x28, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.yaw = packet.readInt8()
      entity.pitch = packet.readInt8()
    })

    // vehicle move
    this.client.onPacket(0x29, packet => {
      const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
      const entity = this.entities.get(this.ridingEid!)
      if (entity) entity.x = x, entity.y = y, entity.z = z
      this.player.x = x, this.player.y = y, this.player.z = z
    })

    // player abilities
    this.client.onPacket(0x2c, packet => {
      const flags = packet.readUInt8()
      this.flyingSpeed = packet.readFloat()
      this.fov = packet.readFloat()
      this.invulnerable = Boolean(flags & 0x1)
      this.flying = Boolean(flags & 0x2)
      this.allowFlying = Boolean(flags & 0x4)
      this.creativeMode = Boolean(flags & 0x8)
    })

    // player list item
    this.client.onPacket(0x2e, packet => {
      const action = packet.readVarInt()
      for (let i = packet.readVarInt(); i--;) {
        const uuid = packet.read(16).toString("hex")
        if (action == 0) {
          const name = packet.readString(), properties = []
          for (let j = packet.readVarInt(); j--;) properties.push({
            name: packet.readString(), value: packet.readString(),
            signature: packet.readBool() ? packet.readString() : undefined
          })
          this.players.set(uuid, { name, gamemode: packet.readVarInt(), ping: packet.readVarInt(), properties })
          if (packet.readBool()) this.players.get(uuid)!.displayName = packet.readJSON()
        } else if (action == 1) {
          if (!this.players.has(uuid)) continue
          this.players.get(uuid)!.gamemode = packet.readVarInt()
        } else if (action == 2) {
          if (!this.players.has(uuid)) continue
          this.players.get(uuid)!.ping = packet.readVarInt()
        } else if (action == 3) {
          if (!this.players.has(uuid)) continue
          if (!packet.readBool()) delete this.players.get(uuid)!.displayName
          else this.players.get(uuid)!.displayName = packet.readString()
        } else if (action == 4) {
          this.players.delete(uuid)
        }
      }
    })

    // player position and look
    this.client.onPacket(0x2f, packet => {
      const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
      const yaw = packet.readFloat(), pitch = packet.readFloat()
      const flags = packet.readUInt8(), teleportId = packet.readVarInt()
      this.player.x = (flags & 0x01 ? this.player.x : 0) + x
      this.player.y = (flags & 0x02 ? this.player.y : 0) + y
      this.player.z = (flags & 0x04 ? this.player.z : 0) + z
      this.player.yaw = (flags & 0x08 ? this.player.yaw : 0) + yaw
      this.player.pitch = (flags & 0x10 ? this.player.pitch : 0) + pitch
      this.client.send(new PacketWriter(0x0).writeVarInt(teleportId))
    })

    // unlock recipes
    this.client.onPacket(0x31, packet => {
      const action = packet.readVarInt()
      packet.readBool() // crafting book open
      packet.readBool() // filter craftable
      for (let i = packet.readVarInt(); i--;) this.unlockedRecipes.add(packet.readVarInt())
      if (action == 0) for (let i = packet.readVarInt(); i--;) this.unlockedRecipes.add(packet.readVarInt())
    })

    // destroy entities
    this.client.onPacket(0x32, packet => {
      for (let i = packet.readVarInt(); i--;) {
        this.entities.delete(packet.readVarInt())
      }
    })

    // respawn
    this.client.onPacket(0x35, packet => {
      const dimension = packet.readInt32()

      if (this.dimension != dimension) {
        const playerEntity = this.entities.get(this.eid)!
        this.chunks.clear()
        this.maps.clear()
        this.entities.clear()
        this.entities.set(this.eid, playerEntity)
      }

      this.dimension = dimension
      this.difficulty = packet.readUInt8()
      this.gamemode = packet.readUInt8()
      this.levelType = packet.readString()
    })

    // entity head look
    this.client.onPacket(0x36, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.headPitch = packet.readInt8()
    })

    // TODO: 0x38 world border

    // camera
    this.client.onPacket(0x39, packet => {
      this.camera = packet.readVarInt()
    })

    // held item change
    this.client.onPacket(0x3a, packet => this.heldItem = packet.readInt8())

    // entity metadata
    this.client.onPacket(0x3c, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      if (!entity.metadata) entity.metadata = new Map()
      for (const [index, entry] of readMetadata(packet)) {
        entity.metadata.set(index, entry)
      }
    })

    // attach entity
    this.client.onPacket(0x3d, packet => {
      const entity = this.entities.get(packet.readInt32())
      if (!entity) return
      entity.attachedEid = packet.readInt32()
    })

    // entity velocity
    this.client.onPacket(0x3e, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.vx = packet.readInt16()
      entity.vy = packet.readInt16()
      entity.vz = packet.readInt16()
    })

    // entity equipment
    this.client.onPacket(0x3f, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      if (!entity.equipment) entity.equipment = new Map()
      const slot = packet.readVarInt()
      const item = readSlot(packet)
      if (!item) entity.equipment.delete(slot)
      else entity.equipment.set(slot, item)
    })

    // set experience
    this.client.onPacket(0x40, packet => {
      this.xpBar = packet.readFloat()
      this.level = packet.readVarInt()
      this.totalXp = packet.readVarInt()
    })

    // update health
    this.client.onPacket(0x41, packet => {
      this.health = packet.readFloat()
      this.food = packet.readVarInt()
      this.saturation = packet.readFloat()
      if (this.profile.settings.autoDisconnect.enabled
        && (!this.profile.settings.autoDisconnect.disableWhilePlaying || !this.conn)
        && this.health < this.profile.settings.autoDisconnect.health
        && this.healthInitialized) {
        this.disconnectReason = { text: "Disconnected because of low health" }
        this.client.end()
      }
      this.healthInitialized = true
    })

    // set passengers
    this.client.onPacket(0x43, packet => {
      const eid = packet.readVarInt()
      const entity = this.entities.get(eid)
      if (!entity) return
      if (this.ridingEid == eid) this.ridingEid = null
      entity.passengers = new Set()
      for (let i = packet.readVarInt(); i--;) {
        const passengerEid = packet.readVarInt()
        if (passengerEid == this.eid) this.ridingEid = this.eid
        entity.passengers.add(passengerEid)
      }
    })

    // teams
    this.client.onPacket(0x44, packet => {
      const name = packet.readString()
      const mode = packet.readInt8()
      if (mode == 0 || mode == 2) {
        const displayName = packet.readString()
        const prefix = packet.readString(), suffix = packet.readString()
        const flags = packet.readUInt8(), nameTagVisibility = packet.readString()
        const collisionRule = packet.readString(), color = packet.readInt8()
        if (mode == 0) {
          this.teams.set(name, {
            displayName, prefix, suffix, flags, nameTagVisibility, collisionRule, color,
            members: new Set([...Array(packet.readVarInt())].map(() => packet.readString()))
          })
        } else {
          const team = this.teams.get(name)
          if (team) this.teams.set(name, {
            ...team, displayName, prefix, suffix, flags, nameTagVisibility, collisionRule, color
          })
        }
      } else if (mode == 1) {
        this.teams.delete(name)
      } else if (mode == 3) {
        const team = this.teams.get(name)
        if (!team) return
        for (let i = packet.readVarInt(); i--;) team.members.add(packet.readString())
      } else if (mode == 4) {
        const team = this.teams.get(name)
        if (!team) return
        for (let i = packet.readVarInt(); i--;) team.members.delete(packet.readString())
      }
    })

    // spawn position
    this.client.onPacket(0x46, packet => this.spawnPosition = packet.readPosition())

    // time update
    this.client.onPacket(0x47, packet => {
      this.worldAge = packet.readUInt64()
      this.time = packet.readUInt64()
    })

    // player list header and footer
    this.client.onPacket(0x4a, packet => {
      this.playerListHeader = packet.readJSON()
      this.playerListFooter = packet.readJSON()
    })

    // entity teleport
    this.client.onPacket(0x4c, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.x = packet.readDouble()
      entity.y = packet.readDouble()
      entity.z = packet.readDouble()
      entity.yaw = packet.readInt8()
      entity.pitch = packet.readInt8()
    })

    // TODO: 0x4d advancements

    // entity properties
    this.client.onPacket(0x4e, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      if (!entity.properties) entity.properties = new Map()
      for (let i = packet.readUInt32(); i--;) {
        const key = packet.readString()
        const value = packet.readDouble()
        const modifiers: EntityProperty["modifiers"] = []
        for (let j = packet.readVarInt(); j--;) modifiers.push({
          uuid: packet.read(16).toString("hex"),
          amount: packet.readDouble(),
          operation: packet.readInt8()
        })
        entity.properties.set(key, { value, modifiers })
      }
    })
  }

  private * getPackets(respawn = false, eid: number) {
    let packet: PacketWriter

    if (respawn) {
      // respawn
      yield new PacketWriter(0x35).writeInt32(this.dimension == 1 ? 0 : 1)
        .writeUInt8(0).writeUInt8(3).writeString("")
      yield new PacketWriter(0x35).writeInt32(this.dimension)
        .writeUInt8(this.difficulty).writeUInt8(this.gamemode & 0x7).writeString(this.levelType)
    } else {
      // join game
      yield new PacketWriter(0x23).writeInt32(eid)
        .writeUInt8(this.gamemode).writeInt32(this.dimension).writeUInt8(this.difficulty)
        .writeUInt8(0).writeString(this.levelType).writeBool(false)
    }

    // player abilities
    yield new PacketWriter(0x2c)
      .writeUInt8(+this.invulnerable | +this.flying << 1 | +this.allowFlying << 2 | +this.creativeMode << 3)
      .writeFloat(this.flyingSpeed).writeFloat(this.fov)

    // player list item
    packet = new PacketWriter(0x2e).writeVarInt(0).writeVarInt(this.players.size)
    for (const [uuid, player] of this.players.entries()) {
      packet.write(Buffer.from(uuid, "hex"))
      packet.writeString(player.name).writeVarInt(player.properties.length)
      for (const { name, value, signature } of player.properties) {
        packet.writeString(name).writeString(value)
        packet.writeBool(signature != null)
        if (signature != null) packet.writeString(signature)
      }
      packet.writeVarInt(player.gamemode).writeVarInt(player.ping)
      packet.writeBool(player.displayName != null)
      if (player.displayName != null) packet.writeString(player.displayName)
    }
    yield packet

    // teams
    for (const [name, team] of this.teams) {
      packet = new PacketWriter(0x44).writeString(name).writeInt8(0)
        .writeString(team.displayName)
        .writeString(team.prefix).writeString(team.suffix)
        .writeUInt8(team.flags).writeString(team.nameTagVisibility)
        .writeString(team.collisionRule).writeInt8(team.color)
      packet.writeVarInt(team.members.size)
      for (const member of team.members) packet.writeString(member)
      yield packet
    }

    // window items
    packet = new PacketWriter(0x14).writeUInt8(0).writeInt16(46)
    for (let i = 0; i < 46; i++) writeSlot(packet, this.inventory.get(i))
    yield packet

    for (const [id, map] of this.maps) {
      packet = new PacketWriter(0x24).writeVarInt(id).writeUInt8(map.scale)
      packet.writeBool(map.showIcons).writeVarInt(map.icons.length)
      for (const icon of map.icons) packet
        .writeUInt8(icon.type << 4 | icon.direction)
        .writeUInt8(icon.x).writeUInt8(icon.y)
      packet.writeUInt8(128).writeUInt8(128).writeUInt8(0).writeUInt8(0)
      packet.writeVarInt(16384).write(Buffer.from(map.data))
      yield packet
    }

    yield new PacketWriter(0x3a).writeInt8(this.heldItem)

    yield new PacketWriter(0x40).writeFloat(this.xpBar).writeVarInt(this.level).writeVarInt(this.totalXp)
    if (this.healthInitialized) yield new PacketWriter(0x41).writeFloat(this.health).writeVarInt(this.food).writeFloat(this.saturation)

    if (this.playerListHeader) yield new PacketWriter(0x4a)
      .writeJSON(this.playerListHeader).writeJSON(this.playerListFooter)

    yield new PacketWriter(0x46, 340).writePosition(this.spawnPosition)
    yield new PacketWriter(0x47).writeUInt64(this.worldAge).writeUInt64(this.time)

    if (this.raining) yield new PacketWriter(0x1e).writeUInt8(2).writeFloat(0)
    if (this.fadeValue != 0) yield new PacketWriter(0x1e).writeUInt8(7).writeFloat(this.fadeValue)
    if (this.fadeTime != 0) yield new PacketWriter(0x1e).writeUInt8(8).writeFloat(this.fadeTime)

    packet = new PacketWriter(0x31)
      .writeVarInt(0).writeBool(false).writeBool(false)
      .writeVarInt(this.unlockedRecipes.size)
    for (const id of this.unlockedRecipes) packet.writeVarInt(id)
    yield packet.writeVarInt(0)

    // player position and look
    yield new PacketWriter(0x2f)
      .writeDouble(this.player.x).writeDouble(this.player.y).writeDouble(this.player.z)
      .writeFloat(this.player.yaw).writeFloat(this.player.pitch).writeUInt8(0)
      .writeVarInt(0)

    for (const [eid, entity] of this.entities) {
      if (entity.type == "object") {
        yield new PacketWriter(0x0)
          .writeVarInt(eid).write(Buffer.from(entity.uuid!, "hex")).writeInt8(entity.objectType!)
          .writeDouble(entity.x).writeDouble(entity.y).writeDouble(entity.z)
          .writeInt8(entity.pitch!).writeInt8(entity.yaw!)
          .writeInt32(entity.objectData!)
          .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!)
      } else if (entity.type == "orb") {
        yield new PacketWriter(0x1)
          .writeVarInt(eid)
          .writeDouble(entity.x).writeDouble(entity.y).writeDouble(entity.z)
          .writeInt16(entity.orbCount!)
      } else if (entity.type == "mob") {
        packet = new PacketWriter(0x3, 340)
          .writeVarInt(eid).write(Buffer.from(entity.uuid!, "hex")).writeVarInt(entity.mobType!)
          .writeDouble(entity.x).writeDouble(entity.y).writeDouble(entity.z)
          .writeInt8(entity.yaw!).writeInt8(entity.pitch!).writeInt8(entity.headPitch!)
          .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!)
        yield writeMetadata(packet, entity.metadata!)
      } else if (entity.type == "painting") {
        yield new PacketWriter(0x4, 340)
          .writeVarInt(eid).write(Buffer.from(entity.uuid!, "hex"))
          .writeString(entity.paintingTitle!)
          .writePosition(entity.x, entity.y, entity.z)
          .writeVarInt(entity.paintingDirection!)
      } else if (entity.type == "player" && eid != this.eid) {
        packet = new PacketWriter(0x5, 340)
          .writeVarInt(eid).write(Buffer.from(entity.uuid!, "hex"))
          .writeDouble(entity.x).writeDouble(entity.y).writeDouble(entity.z)
          .writeInt8(entity.yaw!).writeInt8(entity.pitch!)
        yield writeMetadata(packet, entity.metadata!)
      }

      if (entity.metadata && entity.type != "mob" && (entity.type != "player" || eid == this.eid)) {
        yield writeMetadata(new PacketWriter(0x3c, 340).writeVarInt(eid), entity.metadata)
      }

      if (entity.properties) {
        packet = new PacketWriter(0x4e).writeVarInt(eid).writeUInt32(entity.properties.size)
        for (const [key, property] of entity.properties) {
          packet.writeString(key).writeDouble(property.value).writeVarInt(property.modifiers.length)
          for (const modifier of property.modifiers) packet.write(Buffer.from(modifier.uuid, "hex"))
            .writeDouble(modifier.amount).writeInt8(modifier.operation)
        }
        yield packet
      }

      if (entity.equipment) {
        for (const [slot, item] of entity.equipment) yield writeSlot(
          new PacketWriter(0x3f).writeVarInt(eid).writeVarInt(slot), item
        )
      }
    }

    if (this.camera != null) yield new PacketWriter(0x39).writeVarInt(this.camera)

    for (const [eid, entity] of this.entities) {
      if (entity.passengers) {
        packet = new PacketWriter(0x43).writeVarInt(eid).writeVarInt(entity.passengers.size)
        for (const eid of entity.passengers) packet.writeVarInt(eid)
        yield packet
      }
      if (entity.attachedEid) yield new PacketWriter(0x3d).writeInt32(eid).writeInt32(entity.attachedEid)
    }

    // chunk data
    for (const chunks of this.chunks.values()) {
      for (const chunk of toRaw(chunks).values()) {
        packet = new PacketWriter(0x20)
        packet.writeInt32(chunk.x)
        packet.writeInt32(chunk.z)
        packet.writeBool(true)

        const bitsPerBlock = 13
        const writer = new PacketWriter(0)
        writer.buffer = Buffer.alloc(1024 * 16)
        writer.offset = 0

        let sectionBitMask = 0
        for (let s = 0; s < 16; s++) {
          const section = chunk.sections[s]
          if (!section) continue

          sectionBitMask |= 1 << s
          writer.writeUInt8(bitsPerBlock)
          writer.writeVarInt(0)
          writer.writeVarInt(4096 * bitsPerBlock / 64)

          const data = Buffer.alloc(4096 * bitsPerBlock / 8)
          for (let i = 0; i < 4096; i++) {
            const start = (i * bitsPerBlock / 32) | 0
            const end = (((i + 1) * bitsPerBlock - 1) / 32) | 0
            const offset = (i * bitsPerBlock) % 32
            const first = (start - start % 2 * 2 + 1) * 4
            data.writeInt32BE(data.readInt32BE(first) | section.blocks[i] << offset, first)
            if (start != end) {
              const last = (end - end % 2 * 2 + 1) * 4
              data.writeInt32BE(data.readInt32BE(last) | section.blocks[i] >>> (32 - offset), last)
            }
          }
          writer.write(data)
          writer.write(section.blockLight)
          if (this.dimension == 0) writer.write(section.skyLight!)
        }
        writer.write(chunk.biomes)

        packet.writeVarInt(sectionBitMask)
        packet.writeVarInt(writer.offset)
        packet.write(writer.encode())

        packet.writeVarInt(chunk.blockEntities.length)
        for (const blockEntity of chunk.blockEntities) packet.writeNBT("", blockEntity)

        yield packet
      }
    }
  }

  private mapClientboundPacket(packet: PacketReader, clientEid: number): Buffer {
    packet = packet.clone()
    if ([0x6, 0x8, 0x26, 0x27, 0x28, 0x30, 0x33, 0x36, 0x39, 0x3e, 0x3f, 0x4c, 0x4e, 0x4f].includes(packet.id)) {
      // entity and player related packets
      const eid = packet.readVarInt()
      return new PacketWriter(packet.id).writeVarInt(eid == this.eid ? clientEid : eid)
        .write(packet.buffer.slice(packet.offset)).encode()
    } else if (packet.id == 0x3c) {
      // entity metadata
      const entityEid = packet.readVarInt()
      const entity = this.entities.get(entityEid)
      const metadata = readMetadata(packet)

      metadata.forEach((entry, index) => {
        if (entity && entity.objectType == 76 && index == 7 && entry.type == 1) {
          // entity which has used fireworks
          entry.value = entry.value == this.eid ? clientEid : entry.value
        }
      })

      const writer = new PacketWriter(packet.id, 340)
        .writeVarInt(entityEid == this.eid ? clientEid : entityEid)
      return writeMetadata(writer, metadata).encode()
    } else if (packet.id == 0x1b) {
      // entity status
      const eid = packet.readInt32()
      return new PacketWriter(packet.id).writeInt32(eid == this.eid ? clientEid : eid).writeUInt8(packet.readUInt8()).encode()
    } else if (packet.id == 0x43) {
      // set passengers
      const vehicle = packet.readVarInt(), count = packet.readVarInt()
      const writer = new PacketWriter(0x43).writeVarInt(vehicle).writeVarInt(count)
      for (let i = 0; i < count; i++) {
        const eid = packet.readVarInt()
        writer.writeVarInt(eid == this.eid ? clientEid : eid)
      }
      return writer.encode()
    }

    return packet.buffer
  }

  private mapServerboundPacket(packet: PacketReader, clientEid: number): Buffer {
    packet = packet.clone()

    if (packet.id == 0xd || packet.id == 0xe) {
      // player position and look
      this.player.x = packet.readDouble()
      this.player.y = packet.readDouble()
      this.player.z = packet.readDouble()
      if (packet.id == 0xe) {
        this.player.yaw = packet.readFloat()
        this.player.pitch = packet.readFloat()
      }
    } else if (packet.id == 0xf) {
      // player look
      this.player.yaw = packet.readFloat()
      this.player.pitch = packet.readFloat()
    } else if (packet.id == 0x10) {
      // vehicle move
      const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
      const entity = this.entities.get(this.ridingEid!)
      if (entity) entity.x = x, entity.y = y, entity.z = z
      this.player.x = x, this.player.y = y, this.player.z = z
    } else if (packet.id == 0x15) {
      // entity action
      const eid = packet.readVarInt(), action = packet.readVarInt()
      return new PacketWriter(0x15).writeVarInt(eid == clientEid ? this.eid : eid)
        .writeVarInt(action).writeVarInt(packet.readVarInt()).encode()
    } else if (packet.id == 0x1a) {
      // held item change
      this.heldItem = packet.readInt16()
    }

    return packet.buffer
  }

  private getChunk(x: number, z: number) {
    const chunks = this.chunks.get(x)
    if (chunks) return chunks.get(z)
  }

  private deleteChunk(x: number, z: number) {
    const chunks = this.chunks.get(x)
    if (chunks) {
      chunks.delete(z)
      if (chunks.size == 0) this.chunks.delete(x)
    }
  }

  private setChunk(x: number, z: number, chunk: Chunk) {
    const chunks = this.chunks.get(x)
    if (!chunks) return (this.chunks.set(x, new Map([[z, chunk]])), chunk)
    return (chunks.set(z, chunk), chunk)
  }
}

function readMetadata(packet: PacketReader): Metadata {
  const metadata = new Map<number, MetadataEntry>()
  while (true) {
    const index = packet.readInt8()
    if (index == -1) break
    const type = packet.readVarInt()
    switch (type) {
      case 0: metadata.set(index, { type, value: packet.readInt8() }); break
      case 1: metadata.set(index, { type, value: packet.readVarInt() }); break
      case 2: metadata.set(index, { type, value: packet.readFloat() }); break
      case 3: metadata.set(index, { type, value: packet.readString() }); break
      case 4: metadata.set(index, { type, value: packet.readJSON() }); break
      case 5: metadata.set(index, { type, value: readSlot(packet) }); break
      case 6: metadata.set(index, { type, value: packet.readBool() }); break
      case 7: metadata.set(index, {
        type, value: {
          x: packet.readFloat(), y: packet.readFloat(), z: packet.readFloat()
        }
      }); break
      case 8: metadata.set(index, { type, value: packet.readPosition() }); break
      case 9: metadata.set(index, { type, value: packet.readBool() ? packet.readPosition() : null }); break
      case 10: metadata.set(index, { type, value: packet.readVarInt() }); break
      case 11: metadata.set(index, { type, value: packet.readBool() ? packet.read(16) : null }); break
      case 12: metadata.set(index, { type, value: packet.readVarInt() }); break
      case 13: metadata.set(index, { type, value: packet.readNBT()?.value! }); break
      default: throw new Error(`Unexpected metadata type '${type}'`)
    }
  }
  return metadata
}

function writeMetadata(packet: PacketWriter, metadata: Metadata) {
  for (const [index, { type, value }] of metadata) {
    packet.writeUInt8(index)
    packet.writeVarInt(type)
    switch (type) {
      case 0: packet.writeInt8(value); break
      case 1: packet.writeVarInt(value); break
      case 2: packet.writeFloat(value); break
      case 3: packet.writeString(value); break
      case 4: packet.writeJSON(value); break
      case 5: writeSlot(packet, value); break
      case 6: packet.writeBool(value); break
      case 7: packet.writeFloat(value.x).writeFloat(value.y).writeFloat(value.z); break
      case 8: packet.writePosition(value); break
      case 9: packet.writeBool(value != null), value && packet.writePosition(value); break
      case 10: packet.writeVarInt(value); break
      case 11: packet.writeBool(value != null), value && packet.write(value); break
      case 12: packet.writeVarInt(value); break
      case 13: packet.writeNBT("", value); break
    }
  }
  packet.writeInt8(-1)
  return packet
}

function writeSlot(packet: PacketWriter, item?: Item | null) {
  if (!item) return packet.writeInt16(-1)
  return packet.writeInt16(item.id).writeInt8(item.count)
    .writeInt16(item.damage).writeNBT("", item.tag)
}

function readSlot(packet: PacketReader): Item | null {
  const id = packet.readInt16()
  if (id == -1) return null
  return { id, count: packet.readInt8(), damage: packet.readInt16(), tag: packet.readNBT().value }
}

const mod = (x: number, n: number) => ((x % n) + n) % n
