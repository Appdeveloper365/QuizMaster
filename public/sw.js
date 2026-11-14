/* QuizMaster service worker — app-shell precache for offline play and PWA/APK. */
const CACHE = "quizmaster-shell-v3";
const FONT_CACHE = "quizmaster-fonts-v1";
const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["./", "./index.html", "./manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* Google Fonts (cross-origin): network-first with cache fallback so the
     offline-first shells keep their typography when offline. */
  if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cache.match(req)),
      ),
    );
    return;
  }

  /* Same-origin only. */
  if (url.origin !== self.location.origin) return;

  /* Navigations: network-first with a cached shell fallback (offline play). */
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html"))),
    );
    return;
  }

  /* Assets: stale-while-revalidate — serve cached copy immediately, refresh in
     background so updates propagate without waiting for a cache-version bump. */
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
      return hit || fetchPromise;
    }),
  );
});
