import { reactive, effect } from "@vue/reactivity"
import fs = require("fs")
import { debounce } from "./utils"

export interface User {
  name: string
  hash: string
  salt: string
  profiles: Set<string>
}

export interface Profile {
  id: string
  name: string
  accessToken: string
}

export interface Token {
  token: string
  createdAt: number
  user: string
}

export interface PushSubscription {
  endpoint: string
  keys: any
  user: string
  created: number
}

export const users = reactive(new Map<string, User>())
export const profiles = reactive(new Map<string, Profile>())
export const tokens = reactive(new Map<string, Token>())
export const pushSubscriptions = reactive(new Map<string, PushSubscription>())

function save(name: string, data: any) {
  // use sync api to prevent data loss from normal crashes
  fs.writeFileSync(`data/${name}.json`, JSON.stringify(data, null, 2))
}

function load<T extends any>(name: string, callback: (data: T) => void) {
  if (fs.existsSync(`data/${name}.json`)) {
    callback(JSON.parse(fs.readFileSync(`data/${name}.json`, "utf-8")))
  }
}

if (!fs.existsSync("data")) {
  fs.mkdirSync("data")
  console.log("Created 'data' folder")
}

load<User[]>("users", data => data.forEach(user => users.set(user.name, { ...user, profiles: new Set(user.profiles) })))
load<Profile[]>("profiles", data => data.forEach(profile => profiles.set(profile.id, profile)))
load<Token[]>("tokens", data => data.forEach(token => tokens.set(token.token, token)))
load<PushSubscription[]>("push-subscriptions", data => data.forEach(sub => pushSubscriptions.set(sub.endpoint, sub)))

effect(() => save("users", [...users.values()].map(user => ({ ...user, profiles: [...user.profiles] }))), {
  scheduler: debounce(job => job(), 1000)
})
effect(() => save("profiles", [...profiles.values()]), { scheduler: debounce(job => job(), 1000) })
effect(() => save("tokens", [...tokens.values()]), { scheduler: debounce(job => job(), 1000) })
effect(() => save("push-subscriptions", [...pushSubscriptions.values()]), { scheduler: debounce(job => job(), 1000) })
