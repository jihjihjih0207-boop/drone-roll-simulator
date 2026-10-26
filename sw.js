/*
 * 서비스 워커 — 앱을 인터넷 없이도 열 수 있게 파일을 저장해 둠
 *
 * 방식: '인터넷 먼저' (network-first)
 *   - 인터넷이 되면 항상 서버의 최신 파일을 받아서 쓰고, 받은 파일은 저장해 둠
 *     → GitHub에 새 버전을 올리면 다음에 열 때 바로 새 버전이 됨
 *   - 인터넷이 안 되면(또는 4초 넘게 응답이 없으면) 저장해 둔 파일로 실행
 */
const CACHE = 'drone-sim';
const TIMEOUT_MS = 4000;

// 설치될 때: 첫 화면과 그 화면이 쓰는 파일(js, css, 아이콘)을 미리 저장
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch('./', { cache: 'no-store' });
    const html = await res.clone().text();
    await cache.put('./', res);
    const files = new Set(['./manifest.webmanifest', './icon-192.png', './icon-512.png']);
    for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) files.add(m[1]);
    await Promise.all([...files].map((f) => cache.add(f).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // 업데이트 확인은 항상 서버에 직접 물어봄

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './' : req;
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    if (!cached) return network; // 저장된 게 없으면 인터넷으로만
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), TIMEOUT_MS));
    return Promise.race([network.catch(() => cached), timeout]);
  })());
});
