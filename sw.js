const CACHE_NAME = "kline-training-shell-v19-chart-tools";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=20261004-chart-tools-v1",
  "./library.js?v=20260925-collect-1",
  "./review_rules.js?v=20261004-review-coach-v1",
  "./app.js?v=20261004-chart-tools-v1",
  "./research_ui.js?v=20260927-research-v1",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.includes("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
