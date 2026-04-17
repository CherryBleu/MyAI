self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.open("myai-shell-v2").then(async (cache) => {
      try {
        const fresh = await fetch(request);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          return (await cache.match("/")) || new Response("Offline", { status: 503 });
        }
        return new Response("Offline", { status: 503 });
      }
    })
  );
});
