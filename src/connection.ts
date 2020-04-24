import { Client, PacketReader, PacketWriter, Packet, ServerConnection, State, nbt } from "mcproto"
import { reactive, markRaw } from "@vue/reactivity"
import * as chat from "mc-chat-format"
import { validateOrRefreshToken } from "./utils"
import { Profile } from "./data"

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
  icons: Buffer[]
  data: number[]
}

export interface Item {
  id: number
  count: number
  damage: number
  tag: nbt.Tag | null
}

export interface Entity {
  type: "object" | "orb" | "global" | "mob" | "painting" | "player"
  spawn: PacketReader
  passengers?: number[]
  properties?: Map<string, Buffer>
  metadata?: Map<number, Buffer>
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  yaw?: number
  pitch?: number
  headPitch?: number
}

export interface Player {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
}

export type Chunk = PacketReader[]

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
  static async connect(profile: Profile, host = "localhost", port = 25566) {
    if (!await validateOrRefreshToken(profile)) throw new Error("Failed to refresh token")

    const client = await Client.connect(host, port, {
      profile: profile.id,
      accessToken: profile.accessToken
    })

    client.send(new PacketWriter(0x0).writeVarInt(340)
      .writeString(host).writeUInt16(client.socket.remotePort!)
      .writeVarInt(State.Login))

    client.send(new PacketWriter(0x0).writeString(profile.name))

    let disconnectReason: chat.StringComponent | undefined

    const disconnectListener = client.onPacket(0x0, packet => {
      disconnectReason = chat.convert(packet.readJSON())
      client.end()
    })

    try {
      await client.nextPacket(0x2, false)
      disconnectListener.dispose()
    } catch (error) {
      if (disconnectReason) {
        throw new ConnectError(disconnectReason)
      }
    }

    return new Connection(profile.id, client)
  }

  // Properties for state tracking
  player: Player = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
  inventory = new Map<number, Item>()

  players = new Map<string, PlayerListItem>()
  teams = new Map<string, Team>()
  bossBars = new Map<string, BossBar>()
  maps = new Map<number, MapData>()

  chunks = new Map<number, Map<number, Chunk>>()
  entities = new Map<number, Entity>()
  objects = new Map<number, number>()

  eid = -1
  gamemode = 0
  dimension = 0
  difficulty = 0
  levelType = "default"

  health?: PacketReader
  xp?: PacketReader
  tab?: PacketReader
  playerAbilities?: PacketReader
  time?: PacketReader
  spawn?: PacketReader

  heldItem = 0
  raining = false
  fadeValue = 0
  fadeTime = 0

  riding: number | null = null

  // Connection related properties
  conn: ServerConnection | null = null
  disconnectReason?: chat.StringComponent
  userHasDisconnected = false

  chatListeners = new Set<(message: chat.StringComponent) => void>()
  lastChatMessages: chat.StringComponent[] = []

  queue: Queue | null = null

  constructor(public id: string, public client: Client) {
    this.client = markRaw(client)

    this.client.onPacket(0x1a, packet => {
      this.disconnectReason = chat.convert(packet.readJSON())
      this.client.end()
    })

    this.track.call(reactive(this))
  }

  disconnect() {
    this.userHasDisconnected = true
    this.client.end()
  }

  async proxy(conn: ServerConnection, eid = this.eid, respawn = false) {
    if (this.conn) throw new Error("Already proxied")
    reactive(this).conn = conn

    if (this.eid == -1) await this.client.nextPacket(0x23, false)
    if (eid == -1) eid = this.eid

    for (const packet of this.getPackets(respawn, eid)) {
      await conn.send(this.mapClientboundPacket(packet, eid))
    }

    const serverboundListener = conn.on("packet", packet => {
      if (packet.offset != 0 || packet.id == 0x0 || packet.id == 0xb) return
      this.client.send(this.mapServerboundPacket(packet, eid))
    })

    const clientboundListener = this.client.on("packet", packet => conn.send(this.mapClientboundPacket(packet, eid)))
    const endListener = this.client.on("end", () => conn.end())

    const unproxy = () => {
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
      packet.offset += 16
      this.objects.set(eid, packet.readInt8())
      this.entities.set(eid, {
        type: "object", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        yaw: packet.readInt8(), pitch: packet.readInt8(),
        vx: (packet.offset += 4, packet.readInt16()), vy: packet.readInt16(), vz: packet.readInt16(),
        spawn: packet
      })
    })

    // spawn experience orb
    this.client.onPacket(0x1, packet => {
      const eid = packet.readVarInt()
      this.entities.set(eid, {
        type: "orb", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        spawn: packet
      })
    })

    // spawn global entity
    this.client.onPacket(0x2, packet => {
      const eid = packet.readVarInt()
      packet.offset += 1
      this.entities.set(eid, {
        type: "global", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        spawn: packet
      })
    })

    // spawn mob
    this.client.onPacket(0x3, packet => {
      const eid = packet.readVarInt()
      packet.offset += 16, packet.readVarInt()
      this.entities.set(eid, {
        type: "mob", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        yaw: packet.readInt8(), pitch: packet.readInt8(), headPitch: packet.readInt8(),
        vx: packet.readInt16(), vy: packet.readInt16(), vz: packet.readInt16(),
        spawn: packet
      })
    })

    // spawn painting
    this.client.onPacket(0x4, packet => {
      const eid = packet.readVarInt()
      packet.offset += 16, packet.readVarInt()
      this.entities.set(eid, { type: "painting", spawn: packet })
    })

    // spawn player
    this.client.onPacket(0x5, packet => {
      const eid = packet.readVarInt()
      packet.offset += 16
      this.entities.set(eid, {
        type: "player", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
        yaw: packet.readInt8(), pitch: packet.readInt8(),
        spawn: packet
      })
    })

    // update block entity
    // block change
    this.client.on("packet", packet => {
      if (packet.id != 0x9 && packet.id != 0xb) return
      const pos = packet.readPosition()
      const chunk = this.getChunk(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
      if (chunk) chunk.push(packet)
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
      if (chunk) chunk.push(packet)
    })

    // window items
    this.client.onPacket(0x14, packet => {
      if (packet.readUInt8() != 0) return
      const count = packet.readUInt16()
      for (let i = 0; i < count; i++) {
        const id = packet.readInt16()
        if (id == -1) {
          this.inventory.delete(i)
          continue
        }
        this.inventory.set(i, {
          id, count: packet.readInt8(), damage: packet.readInt16(),
          tag: packet.readNBT()?.value
        })
      }
    })

    // set slot
    this.client.onPacket(0x16, packet => {
      if (packet.readInt8() != 0) return
      const slot = packet.readInt16()
      const id = packet.readInt16()
      if (id == -1) return this.inventory.delete(slot)
      this.inventory.set(slot, {
        id, count: packet.readInt8(), damage: packet.readInt16(),
        tag: packet.readNBT()?.value
      })
    })

    // TODO: 0x18 plugin channel
    // TODO: 0x1b entity status

    // explosion
    this.client.onPacket(0x1c, packet => {
      const chunk = this.getChunk(Math.floor(packet.readFloat() / 16), Math.floor((packet.readFloat(), packet.readFloat()) / 16))
      if (chunk) chunk.push(packet)
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
      if (fullChunk) {
        this.setChunk(chunkX, chunkZ, [packet])
      } else {
        const chunk = this.getChunk(chunkX, chunkZ)
        if (chunk) chunk.push(packet)
      }
    })

    // join game
    this.client.onPacket(0x23, packet => {
      this.eid = packet.readInt32()
      this.gamemode = packet.readUInt8()
      this.dimension = packet.readInt32()
      this.difficulty = packet.readUInt8()
      this.levelType = (packet.readUInt8(), packet.readString())
    })

    // map
    this.client.onPacket(0x24, packet => {
      const id = packet.readVarInt()
      const scale = packet.readUInt8()
      const showIcons = packet.readBool()
      const icons = [...Array(packet.readVarInt())].map(() => packet.read(3))
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
      const entity = this.entities.get(this.riding!)
      if (entity) entity.x = x, entity.y = y, entity.z = z
      this.player.x = x, this.player.y = y, this.player.z = z
    })

    // player abilities
    this.client.onPacket(0x2c, packet => this.playerAbilities = packet)

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

    // TODO: 0x31 unlock recipes

    // destroy entities
    this.client.onPacket(0x32, packet => {
      for (let i = packet.readVarInt(); i--;) {
        const eid = packet.readVarInt()
        this.entities.delete(eid)
        this.objects.delete(eid)
      }
    })

    // TODO: 0x33 remove entity effect
    // TODO: 0x34 resource pack send

    // respawn
    this.client.onPacket(0x35, packet => {
      this.dimension = packet.readInt32()
      this.difficulty = packet.readUInt8()
      this.gamemode = packet.readUInt8()
      this.levelType = packet.readString()
      this.maps.clear()
    })

    // entity head look
    this.client.onPacket(0x36, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.headPitch = packet.readInt8()
    })

    // TODO: 0x38 world border
    // TODO: 0x39 camera

    // held item change
    this.client.onPacket(0x3a, packet => this.heldItem = packet.readInt8())

    // TODO: 0x3b display scoreboard

    // entity metadata
    this.client.onPacket(0x3c, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      if (!entity.metadata) entity.metadata = new Map()
      while (true) {
        const index = packet.readUInt8()
        if (index == 0xff) break
        const start = packet.offset
        const type = packet.readVarInt()
        switch (type) {
          case 0: case 6: packet.offset += 1; break
          case 1: case 10: case 12: packet.readVarInt(); break
          case 2: packet.offset += 4; break
          case 3: case 4: packet.readString(); break
          case 5: if (packet.readInt16() != -1) packet.offset += 3, packet.readNBT(); break
          case 7: packet.offset += 12; break
          case 8: packet.offset += 8; break
          case 9: if (packet.readBool()) packet.offset += 8; break
          case 11: if (packet.readBool()) packet.offset += 16; break
          case 13: packet.readNBT(); break
        }
        entity.metadata.set(index, packet.buffer.slice(start, packet.offset))
      }
    })

    // TODO: 0x3d attach entity

    // entity velocity
    this.client.onPacket(0x3e, packet => {
      const entity = this.entities.get(packet.readVarInt())
      if (!entity) return
      entity.vx = packet.readInt16()
      entity.vy = packet.readInt16()
      entity.vz = packet.readInt16()
    })

    // TODO: 0x3f entity equipment

    // set experience
    this.client.onPacket(0x40, packet => this.xp = packet)

    // update health
    this.client.onPacket(0x41, packet => this.health = packet)

    // TODO: 0x42 scoreboard objective

    // set passengers
    this.client.onPacket(0x43, packet => {
      const eid = packet.readVarInt()
      const entity = this.entities.get(eid)
      if (!entity) return
      if (this.riding == eid) this.riding = null
      entity.passengers = [...Array(packet.readVarInt())].map(() => {
        const passengerEid = packet.readVarInt()
        if (passengerEid == this.eid) this.riding = this.eid
        return passengerEid
      })
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

    // TODO: 0x45 update score

    // spawn position
    this.client.onPacket(0x46, packet => this.spawn = packet)

    // time update
    this.client.onPacket(0x47, packet => this.time = packet)

    // TODO: 0x48 title

    // player list header and footer
    this.client.onPacket(0x4a, packet => this.tab = packet)

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
        const start = packet.offset
        packet.offset += 8
        for (let j = packet.readVarInt(); j--;) packet.offset += 25
        entity.properties.set(key, packet.buffer.slice(start, packet.offset))
      }
    })

    // TODO: 0x4f entity effect
  }

  private getPackets(respawn = false, eid: number) {
    const packets: Packet[] = []
    let packet: PacketWriter

    if (respawn) {
      // respawn
      packets.push(new PacketWriter(0x35).writeInt32(this.dimension)
        .writeUInt8(this.difficulty).writeUInt8(this.gamemode & 0x7).writeString(this.levelType))
    } else {
      // join game
      packets.push(new PacketWriter(0x23).writeInt32(eid)
        .writeUInt8(this.gamemode).writeInt32(this.dimension).writeUInt8(this.difficulty)
        .writeUInt8(0).writeString(this.levelType).writeBool(false))
    }

    // player position and look
    packets.push(new PacketWriter(0x2f)
      .writeDouble(this.player.x).writeDouble(this.player.y).writeDouble(this.player.z)
      .writeFloat(this.player.yaw).writeFloat(this.player.pitch).writeUInt8(0)
      .writeVarInt(0))

    // chunk data
    for (const chunks of this.chunks.values()) {
      for (const chunk of chunks.values()) {
        packets.push(...chunk)
      }
    }

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
    packets.push(packet)

    // teams
    for (const [name, team] of this.teams) {
      packet = new PacketWriter(0x44).writeString(name).writeInt8(0)
        .writeString(team.displayName)
        .writeString(team.prefix).writeString(team.suffix)
        .writeUInt8(team.flags).writeString(team.nameTagVisibility)
        .writeString(team.collisionRule).writeInt8(team.color)
      packet.writeVarInt(team.members.size)
      for (const member of team.members) packet.writeString(member)
      packets.push(packet)
    }

    // window items
    packet = new PacketWriter(0x14).writeUInt8(0).writeInt16(46)
    for (let i = 0; i < 46; i++) {
      const slot = this.inventory.get(i)
      if (slot) {
        packet.writeInt16(slot.id).writeInt8(slot.count).writeInt16(slot.damage)
        packet.writeNBT("", slot.tag)
      } else {
        packet.writeInt16(-1)
      }
    }
    packets.push(packet)

    if (this.heldItem != 0) packets.push(new PacketWriter(0x3a).writeInt8(this.heldItem))
    if (this.playerAbilities) packets.push(this.playerAbilities)
    if (this.health) packets.push(this.health)
    if (this.xp) packets.push(this.xp)
    if (this.tab) packets.push(this.tab)
    if (this.time) packets.push(this.time)
    if (this.spawn) packets.push(this.spawn)

    if (this.raining) packets.push(new PacketWriter(0x1e).writeUInt8(2).writeFloat(0))
    if (this.fadeValue != 0) packets.push(new PacketWriter(0x1e).writeUInt8(7).writeFloat(this.fadeValue))
    if (this.fadeTime != 0) packets.push(new PacketWriter(0x1e).writeUInt8(7).writeFloat(this.fadeTime))

    for (const [eid, entity] of this.entities) {
      const spawn = entity.spawn.clone()

      if (entity.type == "object") {
        packets.push(new PacketWriter(0x0)
          .writeVarInt(spawn.readVarInt())
          .write(spawn.read(17))
          .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
          .writeInt8(entity.yaw!).writeInt8(entity.pitch!)
          .writeInt32((spawn.read(26), spawn.readInt32()))
          .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!))
      } else if (entity.type == "orb") {
        packets.push(new PacketWriter(0x1).writeVarInt(spawn.readVarInt())
          .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
          .writeInt16((spawn.read(24), spawn.readUInt16())))
      } else if (entity.type == "mob") {
        packet = new PacketWriter(0x3)
          .writeVarInt(spawn.readVarInt())
          .write(spawn.read(16))
          .writeVarInt(spawn.readVarInt())
          .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
          .writeInt8(entity.yaw!).writeInt8(entity.pitch!).writeInt8(entity.headPitch!)
          .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!)
        for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
        packets.push(packet.writeUInt8(0xff))
      } else if (entity.type == "player") {
        packet = new PacketWriter(0x5)
          .writeVarInt(spawn.readVarInt())
          .write(spawn.read(16))
          .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
          .writeInt8(entity.yaw!).writeInt8(entity.pitch!)
        for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
        packets.push(packet.writeUInt8(0xff))
      } else {
        packets.push(spawn)
      }

      if (entity.metadata && entity.type != "mob" && entity.type != "player") {
        packet = new PacketWriter(0x3c).writeVarInt(eid)
        for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
        packets.push(packet.writeUInt8(0xff))
      }

      if (entity.properties) {
        packet = new PacketWriter(0x4e).writeVarInt(eid).writeUInt32(entity.properties.size)
        for (const [key, buffer] of entity.properties) packet.writeString(key).write(buffer)
        packets.push(packet)
      }
    }

    for (const [eid, entity] of this.entities) if (entity.passengers) {
      packet = new PacketWriter(0x43).writeVarInt(eid).writeVarInt(entity.passengers.length)
      for (const eid of entity.passengers) packet.writeVarInt(eid)
      packets.push(packet)
    }

    for (const [id, map] of this.maps) {
      packet = new PacketWriter(0x24).writeVarInt(id).writeUInt8(map.scale)
      packet.writeBool(map.showIcons).writeVarInt(map.icons.length)
      for (const buf of map.icons) packet.write(buf)
      packet.writeUInt8(128).writeUInt8(128).writeUInt8(0).writeUInt8(0)
      packet.writeVarInt(16384).write(Buffer.from(map.data))
      packets.push(packet)
    }

    return packets.map(packet => new PacketReader(packet instanceof PacketWriter
      ? packet.encode() : packet instanceof Buffer ? packet : packet.buffer))
  }

  private mapClientboundPacket(packet: PacketReader, clientEid: number) {
    packet = packet.clone()
    if ([0x6, 0x8, 0x26, 0x27, 0x28, 0x30, 0x33, 0x36, 0x3e, 0x3f, 0x4c, 0x4e, 0x4f].includes(packet.id)) {
      // entity and player related packets
      const eid = packet.readVarInt()
      return new PacketWriter(packet.id).writeVarInt(eid == this.eid ? clientEid : eid)
        .write(packet.buffer.slice(packet.offset))
    } else if (packet.id == 0x3c) {
      // entity metadata
      const entityEid = packet.readVarInt()
      const writer = new PacketWriter(packet.id)
        .writeVarInt(entityEid == this.eid ? clientEid : entityEid)
      const objectType = this.objects.get(entityEid)
      if (objectType == 76) while (true) {
        const index = packet.readUInt8()
        writer.writeUInt8(index)
        if (index == 0xff) break
        const type = packet.readVarInt()
        writer.writeVarInt(type)
        const start = packet.offset
        if (objectType == 76 && index == 7 && type == 1) {
          // entity which has used fireworks
          const eid = packet.readVarInt()
          writer.writeVarInt(eid == this.eid ? clientEid : eid)
          break
        }
        switch (type) {
          case 0: case 6: packet.offset += 1; break
          case 1: case 10: case 12: packet.readVarInt(); break
          case 2: packet.offset += 4; break
          case 3: case 4: packet.readString(); break
          case 5: packet.readInt16() != -1 && (packet.offset += 3, packet.readNBT()); break
          case 7: packet.offset += 12; break
          case 8: packet.offset += 8; break
          case 9: if (packet.readBool()) packet.offset += 8; break
          case 11: if (packet.readBool()) packet.offset += 16; break
          case 13: packet.readNBT(); break
        }
        writer.write(packet.buffer.slice(start, packet.offset))
      }

      return writer.write(packet.buffer.slice(packet.offset))
    } else if (packet.id == 0x1b) {
      // entity status
      const eid = packet.readInt32()
      return new PacketWriter(packet.id).writeInt32(eid == this.eid ? clientEid : eid).writeUInt8(packet.readUInt8())
    } else if (packet.id == 0x43) {
      // set passengers
      const vehicle = packet.readVarInt(), count = packet.readVarInt()
      const writer = new PacketWriter(0x43).writeVarInt(vehicle).writeVarInt(count)
      for (let i = 0; i < count; i++) {
        const eid = packet.readVarInt()
        writer.writeVarInt(eid == this.eid ? clientEid : eid)
      }
      return writer
    }

    return packet
  }

  private mapServerboundPacket(packet: PacketReader, clientEid: number) {
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
      const entity = this.entities.get(this.riding!)
      if (entity) entity.x = x, entity.y = y, entity.z = z
      this.player.x = x, this.player.y = y, this.player.z = z
    } else if (packet.id == 0x15) {
      // entity action
      const eid = packet.readVarInt(), action = packet.readVarInt()
      return new PacketWriter(0x15).writeVarInt(eid == clientEid ? this.eid : eid)
        .writeVarInt(action).writeVarInt(packet.readVarInt())
    } else if (packet.id == 0x1a) {
      // held item change
      this.heldItem = packet.readInt16()
    }

    return packet
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