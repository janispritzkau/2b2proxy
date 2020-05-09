import { Server, PacketWriter, State, ServerConnection } from "mcproto"
import { Connection, ConnectError, connect } from "./connection"
import * as data from "./data"
import { StringComponent } from "mc-chat-format"

export function createServer(connections: Map<string, Connection>) {
  const server = new Server({
    generateKeyPair: true,
    keepAlive: true,
    keepAliveInterval: 1000
  })

  server.on("connection", async client => {
    await client.nextPacket()

    if (client.state == State.Status) return handleStatus(client, connections)

    if (client.protocol != 340) return client.end(new PacketWriter(0x0).writeJSON({
      translate: "multiplayer.disconnect.outdated_" + (client.protocol < 340 ? "client" : "server"),
      with: ["1.12.2"]
    }))

    // login start
    const username = (await client.nextPacket(0x0)).readString()

    await client.encrypt(username)
    client.setCompression(256)

    const profile = [...data.profiles.values()].find(profile => profile.name == username)
    const user = [...data.users.values()].find(user => user.profiles.has(profile?.id!))

    if (!profile || !user) return client.end(new PacketWriter(0x0).writeJSON({
      text: "You need to connect via one of your profiles"
    }))

    const uuid = "00000000-0000-0000-0000-000000000000"
    const eid = 9999999

    // login success
    await client.send(new PacketWriter(0x2)
      .writeString(uuid)
      .writeString(username))

    // join game
    await client.send(new PacketWriter(0x23)
      .writeInt32(eid).writeUInt8(3).writeInt32(1).writeUInt16(0)
      .writeString("flat").writeBool(false))

    // player position and look
    client.send(new PacketWriter(0x2f).write(Buffer.alloc(8 * 3 + 4 * 2 + 2)))

    // player list item
    client.send(new PacketWriter(0x2e)
      .writeVarInt(0).writeVarInt(1)
      .write(Buffer.from(uuid.replace(/-/g, ""), "hex"))
      .writeString(username).writeVarInt(0)
      .writeVarInt(3).writeVarInt(0)
      .writeBool(true).writeJSON({ text: `[Proxy] ${username}`, color: "gray" }))

    const profiles = [...user.profiles].map(name => data.profiles.get(name)!)

    let unproxyLastConnection: () => void | null

    // chat message
    client.onPacket(0x2, async packet => {
      const text = packet.readString()

      let match: RegExpMatchArray | null

      if ((match = text.match(/^\/connect (.+)/))) {
        const input = match[1]
        const profile = profiles.find(profile => profile.name == input || profile.id == input)
          || profiles.find(profile => profile.name.startsWith(input))

        if (!profile) return client.send(new PacketWriter(0xf).writeJSON({
          text: "Profile not found", color: "light_purple"
        }).writeUInt8(1))

        client.send(new PacketWriter(0xf).writeJSON({
          text: `Connecting with ${profile.name}`,
          color: "light_purple"
        }).writeUInt8(1))

        let connection = connections.get(profile.id)!
        if (!connection) try {
          connection = await connect(connections, profile)
        } catch (error) {
          return client.send(new PacketWriter(0xf).writeJSON({
            text: "", extra: [
              { text: "Failed to connect: ", color: "light_purple" },
              error instanceof ConnectError ? error.reason : error.message
            ]
          }).writeUInt8(1))
        }

        if (connection.conn) {
          return client.send(new PacketWriter(0xf).writeJSON({
            text: `Already connected`,
            color: "light_purple"
          }).writeUInt8(1))
        }

        clearInterval(interval)

        if (unproxyLastConnection) unproxyLastConnection()
        unproxyLastConnection = await connection.proxy(client, eid, uuid.replace(/-/g, ""), true)
      } else if ((match = text.match(/^\/disconnect (.+)/))) {
        const input = match[1]
        const profile = profiles.find(profile => profile.name == input || profile.id == input)
          || profiles.find(profile => profile.name.startsWith(input))

        if (!profile) return client.send(new PacketWriter(0xf).writeJSON({
          text: "Profile not found", color: "light_purple"
        }).writeUInt8(1))

        const connection = connections.get(profile.id)
        if (!connection) {
          await client.send(new PacketWriter(0xf).writeJSON({
            text: `${profile.name} is not connected`, color: "light_purple"
          }).writeUInt8(1))
        } else {
          connection.disconnect()
        }
      }
    })

    const sendProfilesMessage = () => {
      const lines: StringComponent[] = profiles.map(profile => {
        const connection = connections.get(profile.id)
        const connected = !!connection?.connected
        const queue = connection?.queue

        return {
          text: `\n${profile.name}, `, extra: [
            { text: connected ? "Connected" : "Disconnected", color: connected ? "green" : "gray" },
            {
              text: queue ? `\n- Position in queue: ${queue.position}, est. time: ${queue.time}` : "",
              color: "gray"
            },
            "\n"
          ],
          hoverEvent: { action: "show_text", value: `Connect with ${profile.name}` },
          clickEvent: { action: "run_command", value: `/connect ${profile.id}` }
        }
      })

      client.send(new PacketWriter(0xf).writeJSON({
        text: "", extra: [{ text: "\n\n\nSelect a profile:\n", color: "gold" }, ...lines]
      }).writeUInt8(1))
    }

    const interval = setInterval(sendProfilesMessage, 10000)
    sendProfilesMessage()

    client.on("end", () => {
      clearInterval(interval)
    })
  })
  return server
}

function handleStatus(client: ServerConnection, connections: Map<string, Connection>) {
  client.onPacket(0x0, () => {
    client.send(new PacketWriter(0x0).writeJSON({
      version: { name: "1.12.2", protocol: 340 },
      players: { online: connections.size, max: data.profiles.size },
      description: {
        text: "", extra: [
          { text: `2b2t Proxy\n`, color: "gold" }
        ]
      }
    }))
  })
  client.onPacket(0x1, packet => {
    client.send(new PacketWriter(0x1).writeInt64(packet.readInt64()))
  })
}
