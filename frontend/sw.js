self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data?.json() || {} } catch { data = { title: 'enneo OS', body: event.data?.text() || '' } }
  event.waitUntil(self.registration.showNotification(data.title || 'enneo OS', {
    body: data.body || '',
    icon: data.icon || '/icons/enni.png',
    tag: data.tag || 'enneo-notification',
    data: { url: data.url || '/chat' },
    renotify: false,
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/chat', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (existing) {
      await existing.focus()
      existing.navigate(target)
      return
    }
    return self.clients.openWindow(target)
  })())
})
