import { createHmac, randomBytes } from "crypto"
import { User, users, tokens } from "./data"

export function validate(username: string, password: string) {
  const user = users.get(username)
  return user != null && user.hash == createPasswordHash(password, user.salt).hash
}

export function createToken(user: User) {
  const token = randomBytes(16).toString("hex")

  tokens.set(token, {
    user: user.name,
    createdAt: Date.now(),
    token
  })

  return token
}

export function createUser(name: string, password: string) {
  const user: User = {
    name, profiles: new Set(),
    ...createPasswordHash(password)
  }

  return users.has(name) ? false : (users.set(name, user), true)
}

export function changePassword(user: User, password: string) {
  users.set(user.name, { ...user, ...createPasswordHash(password) })
}

function createPasswordHash(password: string, salt = randomBytes(8).toString("base64")) {
  return {
    hash: createHmac("sha256", salt)
      .update(password)
      .digest("base64"),
    salt
  }
}
