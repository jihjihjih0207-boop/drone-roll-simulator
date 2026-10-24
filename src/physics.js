/*
 * 쿼드콥터 Roll 자세 시뮬레이션 (물리 계산 + PID + 바람 외란)
 *
 * 핵심 식
 *   오차        e = 0 − θ
 *   PID 출력    u = Kp·e + Ki·∫e dt + Kd·de/dt        (필요한 제어 토크, N·m)
 *   모터 배분   왼쪽(m1, m4) = F0 + ΔF,  오른쪽(m2, m3) = F0 − ΔF   (0 ~ F_max로 제한)
 *   모터 지연   실제 추력은 명령을 바로 따라가지 못하고 τm 만큼 늦게 따라감 (1차 지연)
 *               F ← F + (F명령 − F)·dt/τm
 *   센서        각도 센서: 제어기가 보는 각도 = 실제 각도 + 잡음(표준편차 σ)
 *               자이로 센서: 회전 속도 ω를 직접 잼 (+ 작은 잡음). 실제 비행 제어기처럼
 *               D항의 de/dt는 각도를 미분하지 않고 자이로 값으로 계산 (목표가 0°이므로 de/dt = −ω)
 *               → 게인이 너무 크면 센서 잡음을 키워 떨림이 생기므로 게인을 무한정 키울 수 없음
 *   미분 필터   자이로 잡음을 걸러 내는 저역 통과 필터  ė ← ė + (−ω측정 − ė)·dt/τf
 *   바람 토크   τ바람 = ½·ρ·Cd·A·v·|v| × h                (h: 유효 높이, 가정값)
 *   Roll 토크   τ = (L/√2)·[(F1+F4) − (F2+F3)] + τ바람 − c·ω
 *   각가속도    α = τ / I
 *   오일러 방법 ω ← ω + α·dt,   θ ← θ + ω·dt
 *
 * Fuzzy-PID: 매 순간 Fuzzy 판단기가 (e, ė)를 보고 Kp, Ki, Kd를 기본값 주변에서 바꿈 (fuzzy.js)
 *
 * 부호: Roll + 는 오른쪽이 내려가는 방향
 *       풍속 + 는 왼쪽에서 오른쪽으로 부는 바람 (+ 방향으로 기울게 만듦)
 */

import { fuzzyAdjust } from './fuzzy.js';

export const G = 9.81;      // 중력가속도 (m/s²)
export const RHO = 1.225;   // 공기 밀도 (kg/m³)

// 기본 기체 값 (450mm급 쿼드콥터 예시)
export const DEFAULT_PARAMS = {
  mass: 1.2,            // 전체 질량 (kg)
  motorMass: 0.06,      // 모터 1개 질량 (kg)
  armLength: 0.225,     // 기체 중심 ~ 모터 중심 거리 L (m)
  bodyWidth: 0.12,      // 몸체 가로(좌우) 길이 (m)
  bodyLength: 0.15,     // 몸체 세로(앞뒤) 길이 (m)
  bodyHeight: 0.05,     // 몸체 높이 (m) — 관성모멘트·바람 면적 계산용 고정값
  propDiameter: 0.254,  // 프로펠러 지름 (m) = 10인치
  maxThrust: 8.5,       // 모터 1개 최대 추력 (N)
  initialRollDeg: 20,   // 초기 Roll 각 (°)
  damping: 0.005,       // 공기에 의한 회전 감쇠 계수 c (N·m·s/rad)
  motorTau: 0.02,       // 모터 반응 시간 τm (s): 명령한 추력의 63%에 도달하는 시간
  sensorNoiseDeg: 0.1,  // 각도 센서 잡음 표준편차 (°)
  gyroNoiseDps: 1,      // 자이로 센서 잡음 표준편차 (°/s)
  dFilterTau: 0.005,    // 미분 필터 시간 상수 τf (s) ≈ 차단 주파수 32 Hz
};

export const DEFAULT_GAINS = { kp: 1.5, ki: 0.3, kd: 0.12 };

// 바람 외란 기본값
export const DEFAULT_WIND = {
  type: 'none',        // none | gust | periodic | random | composite
  gustSpeed: 10,       // 돌풍 최대 풍속 (m/s)
  gustStart: 2,        // 돌풍 시작 시각 (s)
  gustDuration: 1,     // 돌풍 지속 시간 (s)
  periodicAmp: 8,      // 주기적 외란 진폭 (m/s)
  periodicFreq: 0.5,   // 주기적 외란 주파수 (Hz)
  turbIntensity: 4,    // 난류 세기 = 풍속 표준편차 (m/s)
  turbTime: 0.5,       // 난류 변화 빠르기 = 상관 시간 (s), 작을수록 빨리 변함
  seed: 1,             // 난수 시드 (같으면 매번 똑같은 바람)
  meanWind: 4,         // 복합 외란의 일정한 바람 (m/s)
  direction: 0,        // 풍향 (°): 0 = 옆바람(왼쪽→오른쪽), 90 = 정면 맞바람(Roll에 영향 없음)
  cd: 1.0,             // 항력계수 Cd (가정값)
  heightEff: 0.08,     // 유효 높이 h (m): 바람 받는 중심 ~ 무게중심 (가정값)
};

export const WIND_LABELS = {
  none: '외란 없음',
  gust: '① 돌풍',
  periodic: '② 주기적 외란',
  random: '③ 불규칙 외란(난류)',
  composite: '④ 복합 외란',
};

export const SIM = {
  dt: 0.002,           // 계산 간격 (s) → 1초에 500번 계산
  duration: 10,        // 시뮬레이션 시간 (s)
  settleBandDeg: 2,    // 정착 기준: 오차가 ±2° 안에 들어와 계속 머무는 시각
  crashDeg: 90,        // 이 각도를 넘으면 전복으로 판단
};

const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** 입력값으로 관성모멘트 등 계산값을 구한다 */
export function computeDerived(p, wind = DEFAULT_WIND) {
  const bodyMass = p.mass - 4 * p.motorMass;      // 모터를 뺀 몸체 질량
  const r = p.armLength / Math.SQRT2;              // X자형: Roll 축에서 모터까지의 거리 = L/√2

  // 관성모멘트 I = Σ m·r²
  //   몸체: 직육면체를 앞뒤 축으로 돌릴 때 (1/12)·m·(가로² + 높이²)
  //   모터: 점질량 4개, 각각 m·r²
  const I_body = (bodyMass * (p.bodyWidth ** 2 + p.bodyHeight ** 2)) / 12;
  const I_motors = 4 * p.motorMass * r * r;
  const I = I_body + I_motors;

  const hover = (p.mass * G) / 4;                  // 제자리 비행에 필요한 모터 1개 추력 F0
  const margin = Math.min(p.maxThrust - hover, hover);
  const maxTorque = 4 * r * Math.max(margin, 0);   // 낼 수 있는 최대 Roll 토크

  // 바람을 받는 옆면 면적 A ≈ (모터 사이 폭 + 프로펠러 지름) × 몸체 높이
  const sideArea = (2 * r + p.propDiameter) * p.bodyHeight;
  // 풍향이 비스듬하면 옆으로 미는 성분(v·cos풍향)만 Roll에 영향 → (v·cos)·|v·cos| = v·|v|·cos·|cos|
  const cosDir = Math.cos(((wind.direction || 0) * Math.PI) / 180);
  const windCoef = 0.5 * RHO * wind.cd * sideArea * wind.heightEff * cosDir * Math.abs(cosDir); // τ바람 = windCoef·v·|v|

  const warnings = [];
  if (bodyMass <= 0) warnings.push('모터 4개 질량이 전체 질량보다 커요.');
  if (p.maxThrust <= hover) {
    warnings.push(`최대 추력이 제자리 비행 추력(${hover.toFixed(2)} N)보다 작아서 뜰 수 없어요.`);
  }

  return { bodyMass, r, I_body, I_motors, I, hover, maxTorque, sideArea, windCoef, warnings };
}

// ── 바람 만들기 ─────────────────────────────────────────────────────

/** 시드가 같으면 항상 같은 순서의 난수를 내는 생성기 (mulberry32) */
function makeRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 평균 0, 표준편차 1인 정규분포 난수 (박스-뮬러 방법) */
function makeGaussian(rand) {
  return () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** 1−cos 돌풍: 0에서 부드럽게 최대 풍속까지 올라갔다가 다시 0으로 */
function gustAt(t, w) {
  if (t < w.gustStart || t > w.gustStart + w.gustDuration) return 0;
  return (w.gustSpeed / 2) * (1 - Math.cos((2 * Math.PI * (t - w.gustStart)) / w.gustDuration));
}

/**
 * 시뮬레이션 전체 시간 동안의 풍속 v(t)를 미리 만든다 (m/s)
 * 불규칙 외란은 '필터를 거친 난수'(1차 저역 필터)라서 갑자기 튀지 않고 부드럽게 변한다.
 *   v ← v − (v / τc)·dt + σ·√(2·dt/τc)·N(0,1)     → 표준편차가 σ인 난류
 */
export function makeWindSeries(w, sim = SIM) {
  const n = Math.round(sim.duration / sim.dt);
  const v = new Float64Array(n + 1);
  const gauss = makeGaussian(makeRandom(w.seed));
  let turb = 0;
  const tc = Math.max(w.turbTime, 0.02);

  for (let i = 0; i <= n; i++) {
    const t = i * sim.dt;
    if (w.type === 'random' || w.type === 'composite') {
      turb += (-turb / tc) * sim.dt + w.turbIntensity * Math.sqrt((2 * sim.dt) / tc) * gauss();
    }
    switch (w.type) {
      case 'gust': v[i] = gustAt(t, w); break;
      case 'periodic': v[i] = w.periodicAmp * Math.sin(2 * Math.PI * w.periodicFreq * t); break;
      case 'random': v[i] = turb; break;
      case 'composite': v[i] = w.meanWind + gustAt(t, w) + turb; break;
      default: v[i] = 0;
    }
  }
  return v;
}

// ── 시뮬레이션 ─────────────────────────────────────────────────────

/**
 * 시뮬레이션 1회 실행 → 시간별 기록 + 평가지표
 * gains = { kp, ki, kd },  wind = DEFAULT_WIND 형식
 * fuzzy = null 이면 고정 게인 PID, DEFAULT_FUZZY 형식이면 Fuzzy-PID
 */
export function simulate(p, gains, { sim = SIM, wind = DEFAULT_WIND, fuzzy = null } = {}) {
  const d = computeDerived(p, wind);
  const n = Math.round(sim.duration / sim.dt);
  const dt = sim.dt;
  const windSpeed = makeWindSeries(wind, sim);

  const t = new Float64Array(n + 1);
  const thetaDeg = new Float64Array(n + 1);
  const omega = new Float64Array(n + 1);
  const torque = new Float64Array(n + 1);
  const windTorque = new Float64Array(n + 1);
  const F = [0, 1, 2, 3].map(() => new Float64Array(n + 1));
  const kpT = new Float64Array(n + 1); // 시간별 실제 게인 (Fuzzy가 바꾼 값)
  const kiT = new Float64Array(n + 1);
  const kdT = new Float64Array(n + 1);

  let theta = deg2rad(p.initialRollDeg);
  let w = 0;
  let integral = 0;
  let crashedAt = null;
  let last = n;
  let leftF = d.hover, rightF = d.hover; // 모터가 실제로 내고 있는 추력 (지연 때문에 명령과 다름)
  const lag = p.motorTau > 0 ? Math.min(dt / p.motorTau, 1) : 1;
  const noise = makeGaussian(makeRandom(7919)); // 센서 잡음 (항상 같은 순서 → 공정 비교)
  const noiseRad = deg2rad(p.sensorNoiseDeg || 0);
  const gyroRad = deg2rad(p.gyroNoiseDps || 0);
  let dedtF = 0; // 필터를 거친 오차 변화율 (D항용)
  const dAlpha = p.dFilterTau > 0 ? Math.min(dt / p.dFilterTau, 1) : 1;
  let eF = 0 - theta, ecF = 0; // Fuzzy 입력용 (조금 더 부드럽게: 게인이 덜덜 떨리지 않도록)
  const fAlpha = Math.min(dt / 0.03, 1);

  for (let i = 0; i <= n; i++) {
    const time = i * dt;

    // ① 센서 값(잡음 포함)으로 오차와 PID 계산
    const thetaMeas = theta + noiseRad * noise();     // 각도 센서
    const omegaMeas = w + gyroRad * noise();          // 자이로 센서
    const e = 0 - thetaMeas;
    integral += e * dt;
    dedtF += (-omegaMeas - dedtF) * dAlpha;           // de/dt = −ω, 미분 필터
    const dedt = dedtF;

    // Fuzzy-PID라면 게인을 상황에 맞게 조정 (기본 게인의 ±변경범위 안에서만)
    let kp = gains.kp, ki = gains.ki, kd = gains.kd;
    if (fuzzy) {
      eF += (e - eF) * fAlpha;
      ecF += (dedt - ecF) * fAlpha;
      const adj = fuzzyAdjust(eF, ecF, fuzzy);
      kp = gains.kp * (1 + fuzzy.rangeP * adj.dp);
      ki = gains.ki * (1 + fuzzy.rangeI * adj.di);
      kd = gains.kd * (1 + fuzzy.rangeD * adj.dd);
    }
    const u = kp * e + ki * integral + kd * dedt;

    // ② 모터 배분 (모터는 0 ~ 최대 추력까지만 낼 수 있음)
    const dF = u / (4 * d.r);
    const leftCmd = clamp(d.hover + dF, 0, p.maxThrust);  // m1, m4 명령
    const rightCmd = clamp(d.hover - dF, 0, p.maxThrust); // m2, m3 명령
    leftF += (leftCmd - leftF) * lag;   // 모터 지연: 명령을 천천히 따라감
    rightF += (rightCmd - rightF) * lag;
    const left = leftF, right = rightF;

    // ③ Roll 토크 = 제어 토크 + 바람 토크 − 공기 감쇠
    const tauControl = d.r * (2 * left - 2 * right);
    const v = windSpeed[i];
    const tauWind = d.windCoef * v * Math.abs(v);
    const tau = tauControl + tauWind - p.damping * w;

    // 기록
    t[i] = time;
    thetaDeg[i] = rad2deg(theta);
    omega[i] = w;
    torque[i] = tauControl;
    windTorque[i] = tauWind;
    kpT[i] = kp; kiT[i] = ki; kdT[i] = kd;
    F[0][i] = left; F[3][i] = left;
    F[1][i] = right; F[2][i] = right;

    // ④ 각가속도 → 각속도 → 각도 (오일러 방법)
    const alpha = tau / d.I;
    w += alpha * dt;
    theta += w * dt;

    if (Math.abs(rad2deg(theta)) > sim.crashDeg) {
      crashedAt = time;
      last = i;
      break;
    }
  }

  const result = {
    params: { ...p }, gains: { ...gains }, wind: { ...wind }, fuzzy: fuzzy ? { ...fuzzy } : null, derived: d, sim,
    n: last, t, thetaDeg, omega, torque, windTorque, windSpeed, F, kpT, kiT, kdT, crashedAt,
  };
  result.metrics = computeMetrics(result);
  return result;
}

/**
 * 평가지표: 최대 오차, 오버슈트, 정착시간(±2°), RMSE
 *   - 주기적·불규칙·복합 외란은 바람이 끝까지 불어서 '정착'이 없음 → settle = 'na'
 *   - 돌풍은 돌풍이 시작된 순간부터 다시 ±2° 안에 들어올 때까지의 시간
 *   - 초기 각도가 0°면 '반대쪽으로 넘어감'이 정의되지 않음 → overshoot = null
 */
export function computeMetrics(res) {
  const { thetaDeg, t, n, sim, crashedAt, wind } = res;
  const band = sim.settleBandDeg;

  let maxErr = 0;
  let sumSq = 0;
  for (let i = 0; i <= n; i++) {
    const a = Math.abs(thetaDeg[i]);
    if (a > maxErr) maxErr = a;
    sumSq += thetaDeg[i] ** 2;
  }
  const rmse = Math.sqrt(sumSq / (n + 1));

  const sign0 = Math.sign(thetaDeg[0]);
  let overshoot = null;
  if (sign0 !== 0) {
    overshoot = 0;
    for (let i = 0; i <= n; i++) overshoot = Math.max(overshoot, -sign0 * thetaDeg[i]);
  }

  let settle = null;
  let settleNote = '';
  if (crashedAt !== null) {
    settle = null;
  } else if (['periodic', 'random', 'composite'].includes(wind.type)) {
    settle = 'na';
  } else {
    let lastOut = -1;
    for (let i = 0; i <= n; i++) if (Math.abs(thetaDeg[i]) > band) lastOut = i;
    const from = wind.type === 'gust' ? wind.gustStart : 0;
    if (lastOut === -1) { settle = 0; settleNote = '벗어나지 않음'; }
    else if (lastOut < n) settle = Math.max(t[lastOut + 1] - from, 0);
    // lastOut === n 이면 끝까지 정착하지 못함 → null
  }

  return { maxErr, overshoot, settle, settleNote, rmse, crashed: crashedAt !== null };
}