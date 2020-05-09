import { randomBytes } from "crypto"
import webPush = require("web-push")
import fs = require("fs")

const defaultConfig = {
  vapid: webPush.generateVAPIDKeys(),
  inspector: false,
  proxyPort: 25565,
  apiPort: 4000,
  clientToken: randomBytes(16).toString("hex")
}

if (!fs.existsSync("config.json")) {
  fs.writeFileSync("config.json", JSON.stringify(defaultConfig, null, 2))
  console.log("No config file found. Created 'config.json' with defaults")
}

const config = { ...defaultConfig, ...JSON.parse(fs.readFileSync("config.json", "utf-8")) as {} }
export default config

fs.writeFileSync("config.json", JSON.stringify(config, null, 2))
