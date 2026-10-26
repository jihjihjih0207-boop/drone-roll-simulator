/*
 * 패널(창) 조작: 접기, 닫기, 다시 열기, 크기 조절
 *   - 각 패널은 class="win" 이고, 안에 .win-head / .win-body / .win-resize 가 있음
 *   - 크기 조절 손잡이는 손가락(터치)과 마우스 둘 다 됨
 *   - 닫은 패널은 화면 위쪽 가운데의 버튼으로 다시 열 수 있음
 */
let dock = null;

function updateDock() {
  dock.hidden = ![...dock.children].some((b) => !b.hidden);
}

/** 코드에서 패널을 열 때 (예: 분석이 끝나면 분석 패널 열기) */
export function openWindow(win) {
  win.hidden = false;
  win.classList.remove('collapsed');
  const btnMin = win.querySelector('.win-min');
  if (btnMin) { btnMin.textContent = '—'; btnMin.title = '접기'; }
  if (win._reopen) win._reopen.hidden = true;
  updateDock();
}

export function setupWindows() {
  dock = document.getElementById('dock');

  document.querySelectorAll('.win').forEach((win) => {
    const btnMin = win.querySelector('.win-min');
    const btnClose = win.querySelector('.win-close');
    const handle = win.querySelector('.win-resize');
    const title = win.dataset.title || '패널';

    // 접기 / 펼치기
    btnMin.addEventListener('click', () => {
      const collapsed = win.classList.toggle('collapsed');
      btnMin.textContent = collapsed ? '▢' : '—';
      btnMin.title = collapsed ? '펼치기' : '접기';
    });

    // 닫기 → 위쪽에 '다시 열기' 버튼 생성
    const reopen = document.createElement('button');
    reopen.textContent = `${title} 열기`;
    reopen.hidden = true;
    reopen.addEventListener('click', () => openWindow(win));
    dock.appendChild(reopen);
    win._reopen = reopen;

    btnClose.addEventListener('click', () => {
      win.hidden = true;
      reopen.hidden = false;
      updateDock();
    });

    // 크기 조절 (data-corner: br = 오른쪽 아래 손잡이, tl = 왼쪽 위 손잡이, bl = 왼쪽 아래 손잡이)
    const corner = handle.dataset.corner || 'br';
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = win.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
      handle.setPointerCapture(e.pointerId);
      win.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const sx = corner === 'br' ? 1 : -1;     // 왼쪽 손잡이는 왼쪽으로 끌수록 넓어짐
      const sy = corner === 'tl' ? -1 : 1;     // 위쪽 손잡이는 위로 끌수록 높아짐
      const maxW = window.innerWidth - 32;
      const maxH = window.innerHeight - 32;
      const w = Math.min(Math.max(start.w + sx * dx, 240), maxW);
      const h = Math.min(Math.max(start.h + sy * dy, 120), maxH);
      win.style.width = `${w}px`;
      win.style.height = `${h}px`;
      win.style.maxHeight = 'none';
    });
    const end = () => { start = null; win.classList.remove('resizing'); };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  updateDock();
}
