/*
 * PID 게인 자동 산출 (보고서의 방법을 그대로 코드로)
 *
 * ① 물리식 시작값
 *    Roll 운동 I·θ̈ = u 를 '고유 진동수 ωn, 감쇠비 ζ'인 2차 시스템으로 만들려면
 *      Kp = I·ωn²,  Kd = 2·ζ·ωn·I,  Ki = Kp·ωn/10 (정상상태 오차를 천천히 없애는 정도)
 *    → 관성모멘트 I가 클수록 같은 반응을 내는 데 더 큰 게인이 필요함
 *
 * ② 자동 탐색 (넓게 → 촘촘하게)
 *    시작값 주변을 넓게 훑어서(거친 탐색) 가장 좋은 조합을 찾고,
 *    그 주변을 다시 촘촘하게 탐색(세밀 탐색)
 *
 * ③ 고르는 기준 (세 지표를 하나로 합치지 않음)
 *    - 기준 통과: 전복 없음, 초기 기울기 실험의 오버슈트·정착시간이 한도 이하
 *    - 그중 대상 실험들의 평균 RMSE가 가장 작은 조합
 */
import { simulate, computeDerived, DEFAULT_PARAMS } from './physics.js';

export const DEFAULT_TUNING = {
  wn: 20,           // 목표 고유 진동수 ωn (rad/s): 클수록 빠른 반응
  zeta: 0.8,        // 목표 감쇠비 ζ: 1에 가까울수록 출렁임이 적음
  target: 'all',    // 'all' = 종합(초기 기울기 + 외란 4종), 'current' = 지금 설정한 조건 하나
  osMax: 5,         // 오버슈트 한도 (°)
  settleMax: 1.0,   // 정착시간 한도 (s)
};

/** ① 물리식 시작값 */
export function physicsStart(p, wn, zeta) {
  const { I } = computeDerived(p);
  const kp = I * wn * wn;
  const kd = 2 * zeta * wn * I;
  const ki = (kp * wn) / 10;
  return { kp, ki, kd, I };
}

/** 탐색에 쓸 실험 조건 목록 */
export function buildScenarios(p, wind, target) {
  if (target === 'current') return [{ name: '현재 조건', p: { ...p }, wind: { ...wind } }];
  const z = { ...p, initialRollDeg: 0 };
  return [
    { name: '초기 20° 회복', p: { ...p, initialRollDeg: 20 }, wind: { ...wind, type: 'none' } },
    { name: '① 돌풍', p: z, wind: { ...wind, type: 'gust' } },
    { name: '② 주기적', p: z, wind: { ...wind, type: 'periodic' } },
    { name: '③ 난류', p: z, wind: { ...wind, type: 'random' } },
    { name: '④ 복합', p: z, wind: { ...wind, type: 'composite' } },
  ];
}

/** 게인 1세트를 모든 실험 조건에서 돌려 평가 */
export function evaluate(gains, scenarios, limits, fuzzy = null) {
  const results = scenarios.map((s) => simulate(s.p, gains, { wind: s.wind, fuzzy }));
  const ms = results.map((r) => r.metrics);
  const crashed = ms.some((m) => m.crashed);
  const meanRmse = ms.reduce((a, m) => a + m.rmse, 0) / ms.length;
  const worstMax = Math.max(...ms.map((m) => m.maxErr));

  // 기준은 '초기 기울기에서 회복하는' 실험(또는 현재 조건)의 오버슈트·정착시간으로 판단
  const ref = ms[0];
  const os = ref.overshoot;
  const settle = typeof ref.settle === 'number' ? ref.settle : null;
  let pass = !crashed;
  if (pass && os !== null && os > limits.osMax) pass = false;
  if (pass && ref.settle !== 'na' && (settle === null || settle > limits.settleMax)) pass = false;

  // 모터 출렁임: 추력 명령이 얼마나 크게 흔들리는지 (실제 드론의 떨림·발열과 관련)
  let motor = 0;
  results.forEach((r) => {
    let s2 = 0;
    for (let i = 0; i <= r.n; i++) s2 += (r.F[0][i] - r.derived.hover) ** 2;
    motor += Math.sqrt(s2 / (r.n + 1));
  });
  motor /= results.length;

  return { gains, pass, crashed, meanRmse, worstMax, os, settle, settleNa: ref.settle === 'na', motor, ms };
}

const geom = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo * (hi / lo) ** (i / (n - 1)));
const round = (x) => (x === 0 ? 0 : +x.toPrecision(3));

/**
 * ② 자동 탐색 (async: 화면이 멈추지 않도록 조금씩 나눠서 계산)
 * onProgress(0~1, 메시지)
 */
export async function autoTune(p, wind, opts, onProgress = () => {}) {
  const start = physicsStart(p, opts.wn, opts.zeta);
  const scenarios = buildScenarios(p, wind, opts.target);
  const limits = { osMax: opts.osMax, settleMax: opts.settleMax };

  // 거친 탐색: Kp, Kd는 시작값의 1/4 ~ 8배(7단계), Ki는 0과 1/4 ~ 4배(5단계)
  const coarse = [];
  for (const kp of geom(start.kp / 4, start.kp * 8, 7))
    for (const kd of geom(start.kd / 4, start.kd * 8, 7))
      for (const ki of [0, ...geom(start.ki / 4, start.ki * 4, 4)])
        coarse.push({ kp: round(kp), ki: round(ki), kd: round(kd) });

  const all = [];
  const total = coarse.length + 125;
  let done = 0;
  const runBatch = async (list) => {
    for (let k = 0; k < list.length; k += 8) {
      for (const g of list.slice(k, k + 8)) all.push(evaluate(g, scenarios, limits));
      done += Math.min(8, list.length - k);
      onProgress(done / total, `${done} / ${total} 조합 계산 중`);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await runBatch(coarse);

  // 세밀 탐색: 거친 탐색에서 가장 좋았던 조합 주변 ±40%를 5×5×5로
  const best0 = pickBest(all) || all.reduce((a, b) => (a.meanRmse < b.meanRmse ? a : b));
  const f = [0.6, 0.8, 1, 1.2, 1.4];
  const fine = [];
  for (const a of f) for (const b of f) for (const c of f) {
    fine.push({ kp: round(best0.gains.kp * a), ki: round(best0.gains.ki * b), kd: round(best0.gains.kd * c) });
  }
  await runBatch(fine);

  const ranked = rank(all);
  onProgress(1, '완료');
  return { start, scenarios, ranked, tested: all.length, passed: all.filter((r) => r.pass).length };
}

function pickBest(list) {
  const ok = list.filter((r) => r.pass);
  return ok.length ? ok.reduce((a, b) => (a.meanRmse < b.meanRmse ? a : b)) : null;
}

/** 기준 통과한 것 → 평균 RMSE 작은 순 (같은 게인 중복 제거) */
function rank(list) {
  const seen = new Set();
  return list
    .filter((r) => r.pass)
    .sort((a, b) => a.meanRmse - b.meanRmse)
    .filter((r) => {
      const key = `${r.gains.kp}|${r.gains.ki}|${r.gains.kd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * ④ 공정 비교: 같은 게인을 기본값으로 PID, Fuzzy(표준), Fuzzy(대칭)를 외란 전체에서 비교
 */
export function fairCompare(p, wind, gains, fuzzyBase) {
  const scenarios = buildScenarios(p, wind, 'all');
  const ctrls = [
    { label: 'PID', fuzzy: null },
    { label: 'Fuzzy(표준)', fuzzy: { ...fuzzyBase, table: 'standard' } },
    { label: 'Fuzzy(대칭)', fuzzy: { ...fuzzyBase, table: 'symmetric' } },
  ];
  const rows = scenarios.map((s) => ({
    name: s.name,
    cells: ctrls.map((c) => simulate(s.p, gains, { wind: s.wind, fuzzy: c.fuzzy }).metrics),
  }));
  return { ctrls, rows };
}

/** ⑤ 드론 크기별 최적 게인 (같은 목표 반응, 같은 기준으로 각각 자동 탐색) */
export const SIZE_PRESETS = [
  { name: '소형 (250급)', p: { mass: 0.5, motorMass: 0.03, armLength: 0.125, bodyWidth: 0.08, bodyLength: 0.1, bodyHeight: 0.035, propDiameter: 0.127, maxThrust: 4.5 } },
  { name: '중형 (450급)', p: {} },
  { name: '대형 (650급)', p: { mass: 2.5, motorMass: 0.12, armLength: 0.325, bodyWidth: 0.18, bodyLength: 0.22, bodyHeight: 0.07, propDiameter: 0.381, maxThrust: 15 } },
];

export async function sizeStudy(baseP, wind, opts, onProgress = () => {}) {
  const out = [];
  for (let k = 0; k < SIZE_PRESETS.length; k++) {
    const preset = SIZE_PRESETS[k];
    const p = { ...DEFAULT_PARAMS, ...baseP, ...preset.p };
    const res = await autoTune(p, wind, opts, (f, msg) => onProgress((k + f) / SIZE_PRESETS.length, `${preset.name}: ${msg}`));
    out.push({ name: preset.name, p, I: res.start.I, best: res.ranked[0] || null });
  }
  return out;
}