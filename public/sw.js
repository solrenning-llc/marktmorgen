// Minimal service worker: it makes the site, and each creator's store, installable
// on Android, and keeps a page usable when the connection drops. It never caches a
// payment page, a download, a signed-in page, or a page opened with a private link.
// v5: the review page (and its links) joined the private pages below.
// v6: the site's own build files (/_next/) are left to the browser. They never
// change under one address, so its cache already keeps them, offline too; going
// through this worker only made a second copy of every one of them, and made a
// font the page asks for early arrive twice. The new name empties the old copies.
// v7: a buyer's library (/library) joined the private pages below.
// v8: a draft's private preview (/preview/<code>) joined them; copies kept before are emptied.
const CACHE = "nimbus-v8";
const SHELL = ["/", "/demo", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  // One by one, and none of them required: on a creator's own domain "/" is
  // their store and the site's other pages live elsewhere, and a shell entry
  // that cannot be fetched must not stop the worker from installing.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// A store's own pages that show an order, a membership, a course, its
// members-only community, an affiliate's own numbers, a membership to renew,
// a buyer's own review of an order, or a certificate (which a creator can
// withdraw, so an old copy must never stand in for it), on either address a
// store has (/@name/thanks here, /thanks on its own domain), and the site's
// signed-in pages.
const PRIVATE = /^\/(?:@[^/]+\/)?(?:thanks|orders|manage|course|book|community|affiliates|renew|certificate|review|preview)(?:\/|$)|^\/(?:studio|signin|unsubscribe|library|demo\/thanks)(?:\/|$)/;
const PRIVATE_QUERY = /[?&](?:session_id|token|t|r|ask|ref|v)=/;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never touch anything that involves money, a download or another origin.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/") ||
    url.searchParams.has("_rsc") ||
    PRIVATE.test(url.pathname) ||
    PRIVATE_QUERY.test(url.search)
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          // Offline inside an installed store: its own front page, if it was
          // opened before, rather than the Marktmorgen home page.
          const store = url.pathname.match(/^\/@[^/]+/);
          return (store ? caches.match(store[0]) : Promise.resolve(undefined)).then((page) => page || caches.match("/"));
        }),
      ),
  );
});
