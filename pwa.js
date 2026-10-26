/*
 * 설치형 웹앱(PWA) 기능
 *   - 버전 표시: 입력창 제목 옆 'v1.0.0' (누르면 빌드 시각과 '업데이트 확인' 버튼)
 *   - 앱 설치 버튼: 크롬이 설치를 허락하면 제목 옆에 '앱 설치' 버튼이 생김
 *   - 오프라인 실행: 서비스 워커(public/sw.js) 등록
 *   - 새 버전 알림: 서버의 version.json 과 지금 버전을 비교해서 다르면 위쪽에 알림
 *
 * 버전 숫자는 vite.config.js 의 APP_VERSION 에서 바꿈
 */
/* global __APP_VERSION__, __BUILD_TIME__ */
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const BUILD = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const PROD = import.meta.env.PROD;

// ── 스타일 (이 파일 안에서 직접 넣음) ──
const style = document.createElement('style');
style.textContent = `
  #panel .win-head h1 { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-ver { font-size: 11px; color: #8a9aab; background: rgba(255,255,255,0.06); border-radius: 6px;
    padding: 2px 6px; cursor: pointer; flex: none; border: none; font-family: inherit; }
  .app-ver:hover { background: rgba(255,255,255,0.14); }
  .app-install { font-size: 11px; padding: 3px 8px; background: #0284c7; font-weight: 600; flex: none; }
  #updateBar { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 20;
    display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 10px;
    background: #0c4a6e; border: 1px solid #38bdf8; color: #e0f2fe; font-size: 13px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
  #updateBar button { padding: 5px 10px; font-size: 12px; }
  #updateBar .go { background: #0284c7; font-weight: 600; }
  #verInfo { position: fixed; top: 60px; left: 24px; z-index: 20; width: 260px; padding: 12px 14px;
    border-radius: 10px; background: #111b25; border: 1px solid rgba(255,255,255,0.15); font-size: 12px;
    color: #c9d4de; line-height: 1.6; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
  #verInfo b { color: #e6edf3; }
  #verInfo .row { display: flex; gap: 6px; margin-top: 8px; }
  #verInfo button { padding: 5px 10px; font-size: 12px; }
  #verInfo .msg { color: #4ade80; min-height: 1em; margin-top: 6px; }
`;
document.head.appendChild(style);

// ── 버전 표시와 설치 버튼 (입력창 제목 옆) ──
const head = document.querySelector('#panel .win-head');
const btns = head.querySelector('.win-btns');
const verBtn = document.createElement('button');
verBtn.className = 'app-ver';
verBtn.textContent = PROD ? `v${VERSION}` : `v${VERSION} 개발`;
verBtn.title = '버전 정보 / 업데이트 확인';
head.insertBefore(verBtn, btns);

const installBtn = document.createElement('button');
installBtn.className = 'app-install';
installBtn.textContent = '📲 앱 설치';
installBtn.hidden = true;
head.insertBefore(installBtn, btns);

const fmtTime = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ── 버전 정보 창 ──
let infoBox = null;
verBtn.addEventListener('click', () => {
  if (infoBox) { infoBox.remove(); infoBox = null; return; }
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  infoBox = document.createElement('div');
  infoBox.id = 'verInfo';
  infoBox.innerHTML = `
    <div>버전 <b>v${VERSION}</b></div>
    <div>빌드 ${PROD ? fmtTime(BUILD) : '개발 중 (StackBlitz 미리보기)'}</div>
    <div>실행 방식 ${standalone ? '설치된 앱' : '브라우저'} · ${navigator.onLine ? '온라인' : '오프라인'}</div>
    <div class="row"><button class="chk">업데이트 확인</button><button class="close">닫기</button></div>
    <div class="msg"></div>`;
  document.body.appendChild(infoBox);
  const msg = infoBox.querySelector('.msg');
  infoBox.querySelector('.close').onclick = () => { infoBox.remove(); infoBox = null; };
  infoBox.querySelector('.chk').onclick = async () => {
    if (!PROD) { msg.textContent = '개발 중 화면에서는 확인할 수 없어요.'; return; }
    msg.textContent = '확인 중…';
    const r = await checkUpdate();
    msg.textContent = r === 'new' ? '새 버전이 있어요! 위쪽 알림을 눌러 주세요.'
      : r === 'same' ? '최신 버전이에요.' : '인터넷에 연결되지 않아 확인하지 못했어요.';
  };
});

// ── 앱 설치 ──
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 크롬 기본 안내 대신 우리 버튼으로
  installEvent = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

// ── 서비스 워커 (오프라인 실행) ──
if (PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('서비스 워커 등록 실패', err));
  });
}

// ── 새 버전 확인 ──
let shown = false;
async function checkUpdate() {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return 'error';
    const v = await res.json();
    if (v.build && v.build !== BUILD) { showUpdateBar(v); return 'new'; }
    return 'same';
  } catch {
    return 'error';
  }
}

function showUpdateBar(v) {
  if (shown) return;
  shown = true;
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.innerHTML = `<span>새 버전 <b>v${v.version}</b>이 나왔어요</span><button class="go">지금 업데이트</button><button class="later">나중에</button>`;
  document.body.appendChild(bar);
  bar.querySelector('.go').onclick = () => location.reload();
  bar.querySelector('.later').onclick = () => bar.remove();
}

if (PROD) {
  setTimeout(checkUpdate, 3000);                       // 앱을 열고 3초 뒤
  setInterval(checkUpdate, 30 * 60 * 1000);            // 켜 둔 동안 30분마다
  document.addEventListener('visibilitychange', () => { // 다른 앱 갔다가 돌아왔을 때
    if (document.visibilityState === 'visible') checkUpdate();
  });
}
