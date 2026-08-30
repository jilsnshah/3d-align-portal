/* Service worker for the 3D Align portal.

   Deliberately conservative. The usual mistake is caching the app shell
   first-from-cache, which strands people on an old build after a deploy — and
   this app talks to a lab about live cases, so a stale copy is worse than a
   slow one.

   So: the network decides, always. The cache exists for one purpose, which is
   to say something honest when the network is gone instead of showing the
   browser's dinosaur or, inside an installed app, a blank white screen.

   Hashed build assets are the exception. Their filenames change whenever their
   contents do, so serving one from cache can never be stale.
*/

const VERSION = "v1";
const SHELL = `3dalign-shell-${VERSION}`;
const ASSETS = `3dalign-assets-${VERSION}`;
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll([OFFLINE])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("3dalign-") && k !== SHELL && k !== ASSETS)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. A cached case, plan or payment state is a wrong answer
  // presented as a current one.
  if (url.pathname.startsWith("/api/")) return;

  // Every route in a single-page app is served by the same document, so a
  // navigation is answered from the network and only falls back to the offline
  // page when there is no network at all.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  // Build output is content-hashed, so a hit can never be the wrong version.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSETS).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});


/* --- Notifications -------------------------------------------------------
   The alerts the portal already raises, shown by the device. The worker is
   what receives them: an installed app is usually not running, and this is the
   only thing that is. */

self.addEventListener("push", (event) => {
  let payload = { title: "3D Align", body: "", url: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A push with no readable payload still deserves to be shown rather than
    // dropped, otherwise the browser shows its own "site updated in the
    // background" placeholder instead.
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Alerts about the same case replace each other rather than stacking six
      // deep on the lock screen.
      tag: payload.url,
      renotify: true,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  // Bring the open app forward if it is already running, rather than opening a
  // second copy of it.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if ("focus" in client) {
            client.navigate(target).catch(() => {});
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
