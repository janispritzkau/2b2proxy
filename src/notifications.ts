import { effect, reactive } from "@vue/reactivity"
import * as chat from "mc-chat-format"
import * as webPush from "web-push"
import { Connection } from "./connection"
import { effectDeep } from "./utils"
import * as data from "./data"

export interface Notification {
  title: string
  body?: string
  tag?: string
  renotify?: boolean
  silent?: boolean
}

export async function sendNotification(user: data.User, notification: Notification) {
  for (const subscription of data.pushSubscriptions.values()) {
    if (subscription.user != user.name) continue
    try {
      await webPush.sendNotification(subscription, JSON.stringify(notification))
    } catch (error) {
      if (error instanceof webPush.WebPushError && error.statusCode == 410) {
        data.pushSubscriptions.delete(subscription.endpoint)
      }
    }
  }
}

export function startNotifier(connections: Map<string, Connection>) {
  const intervals = new Map<string, any>()

  effect(() => {
    data.users.forEach(user => {
      let connectionsInQueue = [...connections]
        .filter(([id, conn]) => user.profiles.has(id) && conn.queue)

      const interval = intervals.get(user.name)
      if (connectionsInQueue.length > 0 && !interval) {
        intervals.set(user.name, setInterval(() => {
          notifyConnections(user, connectionsInQueue)
        }, 600000))
      } else if (connectionsInQueue.length == 0 && interval) {
        intervals.delete(user.name)
        clearInterval(interval)
      }
    })

    intervals.forEach((interval, username) => {
      if (!data.users.has(username)) intervals.delete(username), clearInterval(interval)
    })
  })

  effectDeep(track => connections.forEach((connection, id) => connection.connected && track(connection, () => {
    const profile = data.profiles.get(id)!
    let lastQueuePos = 0

    return effect(() => {
      const { queue } = connection
      if (queue) {
        if (lastQueuePos > 10 && queue.position <= 10 || queue.position == 3) {
          notifyQueue(profile, queue.position)
        }
        lastQueuePos = queue.position
      } else if (lastQueuePos > 0) {
        notifyQueue(profile, null)
      }
    }, {
      onStop() {
        if (!connection.userHasDisconnected) notifyDisconnect(profile, connection.disconnectReason)
      }
    })
  })))
}

function notifyConnections(user: data.User, connections: [string, Connection][]) {
  const notification: Notification = {
    title: "2b2proxy",
    body: connections.map(([id, conn]) => {
      return `${data.profiles.get(id)!.name}: ${conn.queue!.position} in queue`
    }).join("\n"),
    tag: "update",
    silent: true
  }

  sendNotification(user, notification)
}

function notifyDisconnect(profile: data.Profile, reason?: chat.StringComponent) {
  const notification: Notification = {
    title: `${profile.name} was disconnected`,
    body: reason && chat.format(reason),
    tag: `disconnect-${profile.id}`,
    renotify: true
  }

  for (const user of data.users.values()) {
    if (user.profiles.has(profile.id)) sendNotification(user, notification)
  }
}

function notifyQueue(profile: data.Profile, queuePosition: number | null) {
  const notification: Notification = {
    title: `${profile.name} is low in queue`,
    body: `Position in queue: ${queuePosition}`,
    tag: `queue-${profile.id}`,
    renotify: true
  }

  for (const user of data.users.values()) {
    if (user.profiles.has(profile.id)) sendNotification(user, notification)
  }
}
