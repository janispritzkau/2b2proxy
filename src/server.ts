import { Server, PacketWriter, State, ServerConnection } from "mcproto"
import { Connection } from "./connection"
import * as data from "./data"

export function createServer(connections: Map<string, Connection>) {
  const server = new Server({
    generateKeyPair: true,
    keepAlive: true
  })

  server.on("connection", async conn => {
    await conn.nextPacket()

    if (conn.state == State.Status) return handleStatus(conn, connections)

    if (conn.protocol != 340) return conn.end(new PacketWriter(0x0).writeJSON({
      translate: "multiplayer.disconnect.outdated_" + (conn.protocol < 340 ? "client" : "server"),
      with: ["1.12.2"]
    }))

    const username = (await conn.nextPacket(0x0)).readString()

    await conn.encrypt(username, true)
    conn.setCompression(256)

    const uuid = "00000000-0000-0000-0000-000000000000"

    conn.send(new PacketWriter(0x2)
      .writeString(uuid)
      .writeString(username))

    for (const connection of connections.values()) {
      if (connection.conn) return conn.end()
      connection.proxy(conn)
      return
    }

    conn.end()
  })

  return server
}

function handleStatus(client: ServerConnection, connections: Map<string, Connection>) {
  client.onPacket(0x0, () => client.send(new PacketWriter(0x0).writeJSON({
    version: { name: "1.12.2", protocol: 340 },
    players: { online: connections.size, max: data.profiles.size },
    description: {
      text: "", extra: [
        { text: `2b2t Proxy\n`, color: "gold" }
      ]
    }
  })))
  client.onPacket(0x1, packet => {
    client.send(new PacketWriter(0x1).writeInt64(packet.readInt64()))
  })
}
