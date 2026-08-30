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
