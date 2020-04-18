import Vue from "vue"

export default new Vue({
  data() {
    return {
      profiles: [],
      connections: {},
      chatBuffer: {},
      selectedProfile: null,
      connected: false
    }
  },
  computed: {
    currentProfile() {
      return this.profiles.find(profile => profile.id == this.selectedProfile)
    },
    connection() {
      return this.connections[this.selectedProfile]
    }
  },
  methods: {
    async connect() {
      const res = await fetch(`/api/profiles/${this.currentProfile.id}/connect`, { method: "POST" })
      const json = await res.json()
      if (!json.success) console.error(json.reason)
    },
    async disconnect() {
      await fetch(`/api/profiles/${this.currentProfile.id}/disconnect`, { method: "POST" })
    },
    sendChatMessage(text) {
      if (!this.connected || !this.connection) return
      this.ws.send(JSON.stringify({
        type: "chat",
        connection: this.connection.id,
        text
      }))
    }
  },
  created() {
    startWebSocket(this)
  }
})

async function startWebSocket(store) {
  while (true) {
    const ws = store.ws = new WebSocket(`${location.protocol.replace("http", "ws")}//${location.host}/api/ws`)

    ws.onopen = () => {
      store.connected = true
    }

    ws.onmessage = event => {
      const data = JSON.parse(event.data)

      if (data.type == "profiles") {
        store.profiles = data.profiles
      }

      if (data.type == "chat") {
        store.chatBuffer[data.connection].push({
          key: Math.random(),
          value: data.message
        })
      }

      if (data.type == "connections") {
        for (const [id, connection] of Object.entries(data.connections)) {
          if (connection) {
            store.$set(store.connections, id, connection)
            if (!(id in store.chatBuffer)) store.$set(store.chatBuffer, id, [])
          } else {
            store.$delete(store.connections, id)
            store.$delete(store.chatBuffer, id)
          }
        }
      }
    }

    await new Promise(resolve => {
      ws.onclose = () => {
        store.connected = false
        setTimeout(resolve, 2000)
      }
    })
  }
}
