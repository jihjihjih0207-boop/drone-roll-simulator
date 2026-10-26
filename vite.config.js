/*
 * Vite 설정 — 설치형 웹앱(PWA) 빌드
 *
 * ★ 업데이트할 때 바꾸는 곳: 아래 APP_VERSION 숫자 하나 (예: '1.0.0' → '1.1.0')
 *   - 화면 왼쪽 아래에 버전으로 표시됨
 *   - 깜빡하고 안 바꿔도, 빌드 시각이 함께 기록돼서 새 버전 알림은 정상으로 뜸
 */
import { defineConfig } from 'vite';
import { makeIcon } from './scripts/icons.js';

const APP_VERSION = '1.0.0';
const BUILD_TIME = new Date().toISOString();

const ICONS = {
  'icon-192.png': () => makeIcon(192),
  'icon-512.png': () => makeIcon(512),
  'icon-maskable-512.png': () => makeIcon(512, { maskable: true }),
};

/** 빌드할 때 아이콘 그림과 version.json 을 만들어 넣는 플러그인 */
function pwaFiles() {
  const cache = {};
  const icon = (name) => (cache[name] ||= ICONS[name]());
  return {
    name: 'pwa-files',
    // 개발 중(StackBlitz 미리보기)에도 아이콘이 보이도록
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url || '').split('?')[0].split('/').pop();
        if (!ICONS[name]) return next();
        res.setHeader('Content-Type', 'image/png');
        res.end(icon(name));
      });
    },
    generateBundle() {
      for (const name of Object.keys(ICONS)) this.emitFile({ type: 'asset', fileName: name, source: icon(name) });
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: APP_VERSION, build: BUILD_TIME }),
      });
    },
  };
}

export default defineConfig({
  base: './', // GitHub Pages(https://아이디.github.io/저장소이름/)에서도 경로가 맞도록
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: { chunkSizeWarningLimit: 1500 },
  plugins: [pwaFiles()],
});
