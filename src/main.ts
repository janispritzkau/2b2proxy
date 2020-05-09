import { reactive, effect, ReactiveEffect, stop, ref } from "@vue/reactivity"
import express = require("express")
import WebSocket = require("ws")
import cookieParser = require("cookie-parser")
import cookie = require("cookie")
import webPush = require("web-push")
import fetch from "node-fetch"
import http = require("http")
import { performance } from "perf_hooks"
import inspector = require("inspector")
import * as chat from "mc-chat-format"

import { Connection, ConnectError, connect, disconnect } from "./connection"
import { startNotifier } from "./notifications"
import { createServer } from "./server"
import * as auth from "./auth"
import * as data from "./data"
import config from "./config"
import { effectDeep, debounce } from "./utils"

webPush.setVapidDetails("mailto:janispritzkau@gmail.com", config.vapid.publicKey, config.vapid.privateKey)

const connections = reactive(new Map<string, Connection>())
const proxyServer = createServer(connections)

const app = express()
const apiServer = http.createServer(app)
const wss = new WebSocket.Server({ server: apiServer })

app.use(cookieParser())
app.use(express.json())

app.post("/api/login", (req, res) => {
  if (auth.validate(req.body.username, req.body.password)) {
    const token = auth.createToken(data.users.get(req.body.username)!)
    res.cookie("auth", token, { maxAge: 28 * 86400000 }).end()
  } else {
    res.status(403).end()
  }
})

app.post("/api/register", (req, res) => {
  const { username, password } = req.body

  if (typeof username != "string" || typeof password != "string" || username == "" || password == "") {
    return res.status(400).end()
  }

  if (auth.createUser(username, password)) {
    res.end()
  } else {
    res.status(400).send({ error: "username_taken" })
  }
})

app.use((req, res, next) => {
  const token = data.tokens.get(req.cookies.auth)
  if (token) {
    res.cookie("auth", token.token, { maxAge: 28 * 86400000 })
    res.locals.token = token.token
    res.locals.user = data.users.get(token.user)
    next()
  } else {
    res.clearCookie("auth").status(401).end()
  }
})

app.post("/api/logout", (req, res) => {
  data.tokens.delete(res.locals.token)
  res.clearCookie("auth").end()
})

app.put("/api/password", (req, res) => {
  const user = res.locals.user as data.User

  const { currentPassword, newPassword } = req.body
  if (typeof newPassword != "string" || newPassword == "") {
    return res.status(400).end()
  }

  if (!auth.validate(user.name, currentPassword)) {
    return res.status(403).end()
  }

  auth.changePassword(user, newPassword)
  res.end()
})

app.get("/api/me", (req, res) => {
  const user = res.locals.user as data.User
  res.json({ name: user.name })
})

app.get("/api/profiles", (req, res) => {
  const user = res.locals.user as data.User
  res.json([...data.profiles.values()]
    .filter(profile => user.profiles.has(profile.id))
    .map(profile => ({ id: profile.id, name: profile.name, settings: profile.settings })))
})

app.post("/api/profiles", (req, res, next) => (async () => {
  const user = res.locals.user as data.User

  if (req.body instanceof Array) {
    for (const profile of req.body) {
      if (typeof profile.id != "string" || typeof profile.name != "string" || typeof profile.accessToken != "string") {
        return res.status(400).end()
      }
      data.profiles.set(profile.id, {
        id: profile.id, name: profile.name, accessToken: profile.accessToken,
        settings: data.defaultProfileSettings
      })
      user.profiles.add(profile.id)
    }
  } else {
    const { username, password } = req.body

    const response = await fetch("https://authserver.mojang.com/authenticate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { name: "Minecraft", version: 1 },
        clientToken: config.clientToken,
        username, password
      })
    })

    if (response.ok) {
      const json = await response.json()
      for (const profile of json.availableProfiles) {
        data.profiles.set(profile.id, {
          id: profile.id, name: profile.name, accessToken: json.accessToken,
          settings: data.defaultProfileSettings
        })
        user.profiles.add(profile.id)
      }
    } else {
      throw new Error(response.statusText)
    }
  }

  res.end()
})().catch(next))

app.put("/api/profiles/:id", (req, res) => {
  const user = res.locals.user as data.User
  const profile = data.profiles.get(req.params.id)
  if (!profile || user.profiles.has(req.params.id)) return res.status(404).end()
  profile.settings = { ...profile.settings, ...req.body.settings }
  res.end()
})

app.delete("/api/profiles/:id", (req, res) => {
  const user = res.locals.user as data.User
  if (user.profiles.delete(req.params.id) && data.profiles.delete(req.params.id)) {
    return res.end()
  } else {
    return res.status(400).end()
  }
})

app.post("/api/profiles/:id/connect", (req, res) => {
  const user = res.locals.user as data.User
  const profile = data.profiles.get(req.params.id)

  if (user.profiles.has(req.params.id) && profile) {
    connect(connections, profile).then(() => {
      res.json({ success: true })
    }).catch(error => {
      res.json({ success: false, reason: error instanceof ConnectError ? error.reason : null, error: error.message })
    })
  } else {
    res.status(400).end()
  }
})

app.post("/api/profiles/:id/disconnect", (req, res) => {
  const user = res.locals.user as data.User
  let profile: data.Profile | undefined
  if (user.profiles.has(req.params.id) && (profile = data.profiles.get(req.params.id))) {
    disconnect(connections, profile)
    return res.end()
  } else {
    return res.status(400).end()
  }
})

app.post("/api/push/subscribe", (req, res) => {
  const user = res.locals.user as data.User

  if (!data.pushSubscriptions.has(req.body.endpoint)) {
    webPush.sendNotification(req.body, JSON.stringify({ title: "2b2proxy", body: "You'll get notified when you are low in queue or got kicked." }))
  }

  data.pushSubscriptions.set(req.body.endpoint, {
    endpoint: req.body.endpoint,
    keys: req.body.keys,
    user: user.name,
    created: Date.now()
  })

  res.end()
})

app.get("/api/push/server-key", (_req, res) => {
  res.json({
    serverKey: config.vapid.publicKey
  })
})

wss.on("connection", (ws, req) => {
  const token = data.tokens.get(cookie.parse(req.headers.cookie || "")["auth"])
  if (!token) return ws.close()

  const effects = new Set<ReactiveEffect>()
  const user = data.users.get(token.user)!

  let time = ref(performance.now())
  let interval = setInterval(() => time.value = performance.now(), 10)

  effects.add(effect(() => {
    ws.send(JSON.stringify({
      type: "profiles",
      profiles: [...user.profiles].map(id => {
        const profile = data.profiles.get(id)!
        return {
          id, name: profile.name, settings: profile.settings
        }
      })
    }))
  }))

  effects.add(effectDeep(track => connections.forEach((connection, id) => track(connection, () => {
    const eff = effect(() => {
      ws.send(JSON.stringify({
        type: "connections",
        connections: {
          [id]: {
            id,
            connected: connection.connected,
            reconnectIn: Math.max(connection.reconnectAt - time.value, 0),
            queue: connection.queue,
            playing: connection.conn != null,
            player: connection.player,
            dimension: connection.dimension
          }
        }
      }))
    }, {
      scheduler: debounce(job => job(), 100),
      onStop() {
        ws.send(JSON.stringify({
          type: "connections",
          connections: { [id]: null }
        }))
        connection.chatListeners.delete(chatListener)
      }
    })

    const chatListener = (message: chat.Component) => ws.send(JSON.stringify({
      type: "chat",
      connection: id,
      message
    }))

    connection.chatListeners.add(chatListener)
    connection.lastChatMessages.forEach(chatListener)

    return eff
  }))))

  ws.on("message", data => {
    if (typeof data != "string") return
    const event = JSON.parse(data)

    if (event.type == "chat") {
      const conn = connections.get(event.connection)
      if (conn) conn.sendChatMessage(event.text)
    }
  })

  ws.on("close", () => {
    effects.forEach(stop)
    clearInterval(interval)
  })
})

apiServer.listen(config.apiPort)
proxyServer.listen(config.proxyPort)

startNotifier(connections)

// expose state for devtool inspection / hacking
Object.assign(global, { apiServer, proxyServer, connections, data })

if (config.inspector) {
  inspector.open()
}
