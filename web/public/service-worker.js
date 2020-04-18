addEventListener("install", () => {
  skipWaiting()
})

addEventListener("push", event => {
  const { title, body, tag, renotify, silent } = JSON.parse(event.data.text())
  event.waitUntil(
      registration.showNotification(title, {
          body, tag, renotify, silent,
          icon: "/img/icons/icon-192x192.png"
      })
  )
})

addEventListener("notificationclick", event => {
  event.notification.close()
  const url = new URL("/", location).href
  event.waitUntil(clients.matchAll().then(clients => {
      for (const client of clients) {
          if (client.url == url) return client.focus()
      }
      return clients.openWindow("/").then(client => client.focus())
  }))
})
