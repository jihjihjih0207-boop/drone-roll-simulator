/*
 * 결과 저장 (보고서용)
 *   - 그래프 그림(PNG): 흰 배경, 제목·축 이름·범례·실험 조건·평가지표까지 한 장에
 *   - 시간별 데이터(CSV): 0.01초 간격의 Roll 각, 각속도, 토크, 풍속, 추력, 게인 → 엑셀에서 열림
 *   - 표(CSV): 실험 기록 표, 분석 패널의 표
 *
 * 파일 저장 방법
 *   - claude.ai 링크(배포본)에서는 Claude의 '파일 저장' 기능을 사용 (저장 확인 창이 뜸)
 *   - 그 밖(StackBlitz 등)에서는 보통 웹사이트처럼 다운로드
 */
import { LIGHT } from './chart.js';

// ── 파일 저장 ─────────────────────────────────────────────────────

let claudeDownloads; // undefined = 아직 확인 안 함, null = 사용 불가

async function getClaudeDownloads() {
  if (claudeDownloads !== undefined) return claudeDownloads;
  claudeDownloads = null;
  if (window.claude && typeof window.claude.use === 'function') {
    try { claudeDownloads = await window.claude.use('downloads'); } catch { claudeDownloads = null; }
  }
  return claudeDownloads;
}

/** 파일 저장. 성공하면 true, 사용자가 취소하면 false */
export async function saveFile(filename, data) {
  const dl = await getClaudeDownloads();
  if (dl) {
    try {
      await dl.save({ filename, data });
      return true;
    } catch (e) {
      if (e && e.code === 'declined') return false;
      if (e && !['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e.code)) throw e;
      // 사용할 수 없으면 아래의 일반 다운로드로
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

/** 파일 이름에 붙일 시각 (예: 20261024-1612) */
export function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── CSV ──────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 2차원 배열 → CSV 글자 (맨 앞의 BOM은 엑셀이 한글을 제대로 읽게 해 줌) */
export function toCSV(rows) {
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** HTML 표 → 2차원 배열 ('적용' 같은 버튼 칸은 뺌) */
export function tableRows(table) {
  const rows = [];
  table.querySelectorAll('tr').forEach((tr) => {
    const r = [];
    tr.querySelectorAll('th, td').forEach((c) => {
      if (c.querySelector('button')) return;
      // 칸 안의 줄바꿈(<br>)은 ' / '로
      const text = [...c.childNodes].map((n) => (n.nodeName === 'BR' ? ' / ' : n.textContent)).join('').trim();
      // '3.28°', '0.30 s', '2.943 N' 처럼 숫자+단위만 있는 칸은 숫자만 남김 → 엑셀에서 계산·그래프 가능
      const m = text.match(/^(-?\d+(?:\.\d+)?)\s?(°|s|N|kg|m|kg·m²)$/);
      r.push(m ? m[1] : text);
    });
    if (r.length) rows.push(r);
  });
  return rows;
}

/**
 * 시간별 데이터 CSV
 * runs = [{ label, res }], info = { 조건 이름: 값 } (맨 위에 실험 조건으로 적음)
 * every = 몇 칸마다 한 줄씩 적을지 (계산 간격 0.002 s × 5 = 0.01 s)
 */
export function runCSV(runs, info, every = 5) {
  const rows = [['드론 Roll 시뮬레이터 결과'], []];
  rows.push(['[실험 조건]']);
  Object.entries(info).forEach(([k, v]) => rows.push([k, v]));
  rows.push([]);
  rows.push(['[평가지표]', '최대 오차(°)', '오버슈트(°)', '정착시간(s)', 'RMSE(°)']);
  runs.forEach((r) => {
    const m = r.res.metrics;
    const settle = m.crashed ? '전복' : m.settle === 'na' ? '해당 없음' : m.settle === null ? '정착 안 됨' : m.settle.toFixed(3);
    rows.push([r.label, m.maxErr.toFixed(3), m.overshoot === null ? '해당 없음' : m.overshoot.toFixed(3), settle, m.rmse.toFixed(3)]);
  });
  rows.push([]);

  const head = ['시간(s)'];
  const hasWind = runs[0].res.wind.type !== 'none';
  if (hasWind) head.push('풍속(m/s)');
  runs.forEach((r) => {
    const L = runs.length > 1 ? `${r.label} ` : '';
    head.push(`${L}Roll(°)`, `${L}각속도(°/s)`, `${L}제어 토크(N·m)`);
    if (hasWind) head.push(`${L}바람 토크(N·m)`);
    head.push(`${L}왼쪽 모터 추력(N)`, `${L}오른쪽 모터 추력(N)`);
    if (r.res.fuzzy) head.push(`${L}Kp`, `${L}Ki`, `${L}Kd`);
  });
  rows.push(head);

  const n = Math.max(...runs.map((r) => r.res.n));
  const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '');
  for (let i = 0; i <= n; i += every) {
    const r0 = runs[0].res;
    const row = [(i * r0.sim.dt).toFixed(3)];
    if (hasWind) row.push(f(r0.windSpeed[i], 3));
    runs.forEach(({ res }) => {
      if (i > res.n) { // 전복으로 먼저 끝난 실험은 빈칸
        row.push('', '', '');
        if (hasWind) row.push('');
        row.push('', '');
        if (res.fuzzy) row.push('', '', '');
        return;
      }
      row.push(f(res.thetaDeg[i], 4), f((res.omega[i] * 180) / Math.PI, 3), f(res.torque[i], 5));
      if (hasWind) row.push(f(res.windTorque[i], 5));
      row.push(f(res.F[0][i], 4), f(res.F[1][i], 4));
      if (res.fuzzy) row.push(f(res.kpT[i], 4), f(res.kiT[i], 4), f(res.kdT[i], 4));
    });
    rows.push(row);
  }
  return toCSV(rows);
}

// ── 보고서용 그림 ─────────────────────────────────────────────────

/**
 * 흰 배경 보고서용 그림 (PNG Blob)
 *   title: 제목, subtitle: 조건 한 줄, legend: [{ color 키 또는 색, text, dash, band }],
 *   metrics: { head: [...], rows: [[...]] }, gainChart: Fuzzy 게인 그래프 (없으면 null)
 */
export function reportPNG({ rollChart, gainChart = null, title, subtitle, legend, metrics, gainLegend = null }) {
  const th = LIGHT;
  const W = 1200, S = 2; // 가로 1200 (저장되는 그림은 2배 = 2400 픽셀)
  const pad = 28;
  const titleH = 74;
  const chartH = 430;
  const legendH = 34;
  const gainH = gainChart ? 170 : 0;
  const rowH = 30;
  const metricsH = metrics ? 16 + rowH * (metrics.rows.length + 1) : 0;
  const H = titleH + chartH + legendH + gainH + metricsH + pad;

  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // 제목
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, pad, 20);
  ctx.fillStyle = '#4b5563';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(subtitle, pad, 50);

  // Roll 그래프
  let y = titleH;
  ctx.save();
  ctx.translate(pad - 8, y);
  rollChart.render(ctx, W - 2 * pad + 8, chartH, th, Infinity, { axisTitles: true, ghost: false });
  ctx.restore();
  y += chartH;

  // 범례
  const drawLegend = (items, yy) => {
    let x = pad + 60;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    items.forEach((it) => {
      const color = th[it.color] || it.color;
      if (it.width === 0) {
        // 선 없이 설명 글자만
      } else if (it.band) {
        ctx.fillStyle = 'rgba(34,197,94,0.3)';
        ctx.fillRect(x, yy - 7, 22, 14);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = it.width || 3;
        ctx.setLineDash(it.dash || []);
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 26, yy); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#374151';
      ctx.fillText(it.text, x + 32, yy);
      x += 32 + ctx.measureText(it.text).width + 26;
    });
  };
  drawLegend(legend, y + 16);
  y += legendH;

  // Fuzzy 게인 그래프
  if (gainChart) {
    ctx.save();
    ctx.translate(pad - 8, y);
    const hasWind = rollChart.windMax > 0;
    gainChart.render(ctx, W - 2 * pad + 8, gainH - 34, th, Infinity, { axisTitles: true, padR: hasWind ? 64 : 12 });
    ctx.restore();
    if (gainLegend) drawLegend(gainLegend, y + gainH - 17);
    y += gainH;
  }

  // 평가지표 표
  if (metrics) {
    y += 8;
    const cols = metrics.head.length;
    const colW = (W - 2 * pad) / cols;
    ctx.font = '14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const line = (yy, color = '#d1d5db') => { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad, yy); ctx.stroke(); };
    line(y, '#6b7280');
    [metrics.head, ...metrics.rows].forEach((r, ri) => {
      const yy = y + rowH * ri + rowH / 2;
      r.forEach((v, ci) => {
        ctx.fillStyle = ri === 0 ? '#6b7280' : '#111827';
        ctx.font = `${ri === 0 ? '' : ci === 0 ? '600 ' : ''}14px system-ui, sans-serif`;
        ctx.textAlign = ci === 0 ? 'left' : 'right';
        ctx.fillText(String(v), ci === 0 ? pad + 6 : pad + colW * (ci + 1) - 10, yy);
      });
      line(y + rowH * (ri + 1), ri === 0 ? '#9ca3af' : '#e5e7eb');
    });
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
