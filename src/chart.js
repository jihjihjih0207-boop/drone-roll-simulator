/*
 * 그래프 (라이브러리 없이 canvas로 직접 그림)
 *
 * RollChart: Roll 각도 그래프
 *   - 일반 모드: 현재 실험(파랑 또는 초록) + 바로 이전 실험(회색)
 *   - 비교 모드: PID(파랑, 굵게) + Fuzzy-PID(초록, 점선)를 동시에
 *   - 풍속(주황, 오른쪽 축)과 정착 범위(초록 띠 ±2°)
 *
 * GainChart: Fuzzy가 바꾼 게인을 '기본 게인 대비 비율'로 보여 주는 작은 그래프
 *
 * 두 그래프 모두 render(ctx, 가로, 세로, 테마)로 그림
 *   → 화면에는 어두운 테마(DARK), 보고서용 그림 저장에는 흰 배경 테마(LIGHT)
 */

export const DARK = {
  bg: null, // 투명 (패널 배경이 보임)
  text: '#9fb0c0', grid: 'rgba(255,255,255,0.08)', zero: 'rgba(255,255,255,0.35)',
  band: 'rgba(34, 197, 94, 0.12)', windText: '#fdba74', font: 11,
  pid: '#38bdf8', fuzzy: '#4ade80', ghost: 'rgba(156, 163, 175, 0.55)', wind: 'rgba(251, 146, 60, 0.75)',
  kp: '#f472b6', ki: '#facc15', kd: '#a78bfa',
};

export const LIGHT = {
  bg: '#ffffff',
  text: '#374151', grid: 'rgba(0,0,0,0.09)', zero: 'rgba(0,0,0,0.45)',
  band: 'rgba(34, 197, 94, 0.13)', windText: '#c2410c', font: 14,
  pid: '#0369a1', fuzzy: '#16a34a', ghost: 'rgba(107, 114, 128, 0.6)', wind: 'rgba(234, 88, 12, 0.8)',
  kp: '#db2777', ki: '#ca8a04', kd: '#7c3aed',
};

function setupCanvas(chart, canvas) {
  chart.canvas = canvas;
  chart.ctx = canvas.getContext('2d');
  chart.resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    chart.w = Math.max(rect.width, 100);
    chart.h = Math.max(rect.height, 60);
    canvas.width = chart.w * dpr;
    canvas.height = chart.h * dpr;
    chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  chart.resize();
  // 패널 크기가 바뀌면 그래프도 다시 그림
  new ResizeObserver(() => { chart.resize(); chart.draw(); }).observe(canvas);
}

const pickStep = (max, px, list) => list.find((s) => (s / max) * px >= 18) || list.at(-1);

function drawLine(ctx, run, arr, X, Yf, upto, color, width, pw, dash = []) {
  if (!run || !arr) return;
  const last = Math.min(upto, run.n);
  const step = Math.max(1, Math.floor(run.n / (pw * 2))); // 화면 픽셀보다 촘촘하면 건너뜀
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  for (let i = 0; i <= last; i += step) {
    const px = X(run.t[i]), py = Yf(arr[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.lineTo(X(run.t[last]), Yf(arr[last]));
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTimeAxis(ctx, X, padT, ph, tMax, th) {
  ctx.textBaseline = 'top';
  const tStep = tMax <= 5 ? 0.5 : 1;
  for (let s = 0; s <= tMax + 1e-9; s += tStep) {
    ctx.strokeStyle = th.grid;
    ctx.beginPath(); ctx.moveTo(X(s), padT); ctx.lineTo(X(s), padT + ph); ctx.stroke();
    const isLast = s + tStep > tMax + 1e-9;
    ctx.textAlign = isLast ? 'right' : 'center';
    ctx.fillText(isLast ? `${+s.toFixed(1)} s` : `${+s.toFixed(1)}`, isLast ? X(s) + 4 : X(s), padT + ph + 6);
  }
}

export class RollChart {
  constructor(canvas, { band = 2 } = {}) {
    this.band = band;
    this.tMax = 10;
    this.yMax = 25;
    this.windMax = 0;
    this.runs = [];      // 지금 그리는 실험들 [{ t, y, n, role, width, dash }]
    this.ghost = null;   // 이전 실험 (일반 모드에서만)
    this.wind = null;    // { t, v, n }
    this.upto = 0;
    setupCanvas(this, canvas);
  }

  #fitAxes(list, wind) {
    let m = 5;
    for (const run of list) if (run) for (let i = 0; i <= run.n; i++) m = Math.max(m, Math.abs(run.y[i]));
    this.yMax = Math.min(Math.ceil((m * 1.15) / 5) * 5, 90);
    this.windMax = 0;
    this.wind = null;
    if (wind) {
      let wm = 0;
      for (let i = 0; i <= wind.n; i++) wm = Math.max(wm, Math.abs(wind.v[i]));
      if (wm > 0.05) { this.windMax = Math.ceil((wm * 1.1) / 5) * 5; this.wind = wind; }
    }
  }

  /** 일반 모드: 새 실험 1개 (이전 실험은 회색으로 남김). role = 'pid' | 'fuzzy' */
  setRun(run, tMax, wind = null, role = 'pid') {
    const prev = this.runs.length === 1 ? this.runs[0] : null;
    this.ghost = prev;
    this.runs = [{ ...run, role }];
    this.tMax = tMax;
    this.#fitAxes([run, this.ghost], wind);
    this.upto = 0;
  }

  /** 비교 모드: PID와 Fuzzy-PID 두 실험을 동시에
   *  (두 선이 겹쳐도 둘 다 보이게 PID는 굵게 아래에, Fuzzy는 점선으로 위에 그림) */
  setCompare(runPid, runFuzzy, tMax, wind = null) {
    this.ghost = null;
    this.runs = [{ ...runPid, role: 'pid', width: 3.5 }, { ...runFuzzy, role: 'fuzzy', width: 2, dash: [7, 5] }];
    this.tMax = tMax;
    this.#fitAxes(this.runs, wind);
    this.upto = 0;
  }

  setProgress(index) { this.upto = index; this.draw(); }

  draw() { this.render(this.ctx, this.w, this.h, DARK, this.upto); }

  /**
   * 그래프 그리기
   * opts.axisTitles = true 이면 축 이름(시간, Roll 각, 풍속)도 씀 (보고서용)
   * opts.ghost = false 이면 이전 실험(회색)을 빼고 그림
   */
  render(ctx, w, h, th, upto = Infinity, opts = {}) {
    const hasWind = this.windMax > 0;
    const k = th.font / 11; // 글자 크기에 맞춰 여백 조절
    const titles = !!opts.axisTitles;
    const padL = (44 + (titles ? 18 : 0)) * k, padR = (hasWind ? 46 + (titles ? 18 : 0) : 12) * k;
    const padT = 10 * k, padB = (26 + (titles ? 16 : 0)) * k;
    const pw = w - padL - padR, ph = h - padT - padB;
    const X = (t) => padL + (t / this.tMax) * pw;
    const Y = (v) => padT + ph / 2 - (v / this.yMax) * (ph / 2);
    const YW = (v) => padT + ph / 2 - (v / this.windMax) * (ph / 2);
    const lw = (x) => x * Math.max(1, k * 0.85);

    if (th.bg) { ctx.fillStyle = th.bg; ctx.fillRect(0, 0, w, h); } else ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = th.band;
    ctx.fillRect(padL, Y(this.band), pw, Y(-this.band) - Y(this.band));

    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.text;
    ctx.font = `${th.font}px system-ui, sans-serif`;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStep = pickStep(this.yMax, ph / 2 / k, [1, 2, 5, 10, 15, 20, 30, 45]);
    const kMax = Math.floor(this.yMax / yStep);
    for (let i = -kMax; i <= kMax; i++) {
      const v = i * yStep;
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(padL + pw, Y(v)); ctx.stroke();
      ctx.fillText(`${v}°`, padL - 6 * k, Y(v));
    }
    if (hasWind) {
      ctx.fillStyle = th.windText;
      ctx.textAlign = 'left';
      const wStep = pickStep(this.windMax, ph / 2 / k, [1, 2, 5, 10, 15, 20, 30]);
      const wk = Math.floor(this.windMax / wStep);
      for (let i = -wk; i <= wk; i++) ctx.fillText(`${i * wStep}`, padL + pw + 6 * k, YW(i * wStep));
      ctx.fillStyle = th.text;
    }
    drawTimeAxis(ctx, X, padT, ph, this.tMax, th);

    if (titles) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('시간 (s)', padL + pw / 2, h - 2 * k);
      ctx.save();
      ctx.translate(14 * k, padT + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle';
      ctx.fillText('Roll 각 (°)', 0, 0);
      ctx.restore();
      if (hasWind) {
        ctx.save();
        ctx.fillStyle = th.windText;
        ctx.translate(w - 12 * k, padT + ph / 2);
        ctx.rotate(Math.PI / 2);
        ctx.textBaseline = 'middle';
        ctx.fillText('풍속 (m/s)', 0, 0);
        ctx.restore();
      }
    }

    ctx.strokeStyle = th.zero;
    ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(padL + pw, Y(0)); ctx.stroke();

    if (this.wind) drawLine(ctx, this.wind, this.wind.v, X, YW, upto, th.wind, lw(1.25), pw);
    if (this.ghost && opts.ghost !== false) drawLine(ctx, this.ghost, this.ghost.y, X, Y, Infinity, th.ghost, lw(1.5), pw);
    for (const run of this.runs) {
      drawLine(ctx, run, run.y, X, Y, upto, th[run.role], lw(run.width || 2), pw, (run.dash || []).map((d) => d * k));
    }

    if (upto > 0 && Number.isFinite(upto)) {
      for (const run of this.runs) {
        const i = Math.min(upto, run.n);
        ctx.fillStyle = th[run.role];
        ctx.beginPath();
        ctx.arc(X(run.t[i]), Y(run.y[i]), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

export class GainChart {
  constructor(canvas) {
    this.run = null; // { t, n, p, i, d } = 기본 게인 대비 비율
    this.range = 0.5;
    this.tMax = 10;
    this.upto = 0;
    setupCanvas(this, canvas);
  }

  setRun(run, tMax, range) {
    this.run = run;
    this.tMax = tMax;
    this.range = Math.max(range, 0.05);
    this.upto = 0;
  }

  setProgress(index) { this.upto = index; this.draw(); }

  draw() { this.render(this.ctx, this.w, this.h, DARK, this.upto); }

  render(ctx, w, h, th, upto = Infinity, opts = {}) {
    const k = th.font / 11;
    const titles = !!opts.axisTitles;
    const padL = (44 + (titles ? 18 : 0)) * k, padR = (opts.padR ?? 12) * k, padT = 8 * k, padB = 22 * k;
    const pw = w - padL - padR, ph = h - padT - padB;
    const lo = 1 - this.range, hi = 1 + this.range;
    const X = (t) => padL + (t / this.tMax) * pw;
    const Y = (v) => padT + ((hi - v) / (hi - lo)) * ph;

    if (th.bg) { ctx.fillStyle = th.bg; ctx.fillRect(0, 0, w, h); } else ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.text;
    ctx.font = `${th.font}px system-ui, sans-serif`;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [lo, 1, hi]) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(padL + pw, Y(v)); ctx.stroke();
      ctx.fillText(`×${v.toFixed(2)}`, padL - 6 * k, Y(v));
    }
    drawTimeAxis(ctx, X, padT, ph, this.tMax, th);
    if (titles) {
      ctx.save();
      ctx.translate(14 * k, padT + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('게인 비율', 0, 0);
      ctx.restore();
    }
    if (!this.run) return;
    const lw = Math.max(1.5, 1.5 * k * 0.85);
    drawLine(ctx, this.run, this.run.p, X, Y, upto, th.kp, lw, pw);
    drawLine(ctx, this.run, this.run.i, X, Y, upto, th.ki, lw, pw);
    drawLine(ctx, this.run, this.run.d, X, Y, upto, th.kd, lw, pw);
  }
}