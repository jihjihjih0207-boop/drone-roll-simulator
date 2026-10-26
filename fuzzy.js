/*
 * Fuzzy 판단기 (Fuzzy-PID의 게인 자동 조정 부분)
 *
 *   입력: 오차 e, 오차 변화율 ė
 *     → 각각 -3 ~ +3 범위로 바꾼 뒤(정규화) 7단계 멤버십 함수로 '애매하게' 분류
 *        NB(음으로 큼) NM NS ZO(0 근처) PS PM PB(양으로 큼)
 *   규칙: 7×7 규칙표 3개 (ΔKp, ΔKi, ΔKd), 두 종류 중 선택
 *     ① 표준 규칙표: 자기조정 퍼지 PID 논문에서 널리 쓰는 표 (출처를 보고서에 밝힐 것)
 *        → 계단 응답(아래에서 목표로 올라가는 상황) 기준이라 오차의 +/− 에 대해 비대칭
 *     ② 대칭 규칙표: 좌우가 대칭인 Roll 운동에 맞춰 이번 탐구에서 설계한 표
 *        → |오차|가 크거나 오차가 커지는 중이면 Kp↑, 오차가 작으면 Ki↑(크면 Ki↓로 적분 누적 방지),
 *          빠르게 되돌아오는 중이면 Kd↑(넘어감 방지)
 *   추론: 각 규칙의 적합도 = min(μe, μė), 출력 = 적합도로 가중평균한 값 (-3 ~ +3)
 *   출력: 게인 변화 비율 -1 ~ +1 → 실제 게인 = 기본 게인 × (1 + 변경범위 × 비율)
 *         변경범위를 제한해서 Fuzzy가 잘못 판단해도 완전히 다른 제어기가 되지 않게 함
 */

export const LABELS = ['NB', 'NM', 'NS', 'ZO', 'PS', 'PM', 'PB'];
const V = { NB: -3, NM: -2, NS: -1, ZO: 0, PS: 1, PM: 2, PB: 3 };

// 행 = 오차 e (NB → PB), 열 = 오차 변화율 ė (NB → PB)
const T = (rows) => rows.map((r) => r.split(' ').map((s) => V[s]));

export const RULES_STANDARD = {
  kp: T([
    'PB PB PM PM PS ZO ZO',
    'PB PB PM PS PS ZO NS',
    'PM PM PM PS ZO NS NS',
    'PM PM PS ZO NS NM NM',
    'PS PS ZO NS NS NM NM',
    'PS ZO NS NM NM NM NB',
    'ZO ZO NM NM NM NB NB',
  ]),
  ki: T([
    'NB NB NM NM NS ZO ZO',
    'NB NB NM NS NS ZO ZO',
    'NB NM NS NS ZO PS PS',
    'NM NM NS ZO PS PM PM',
    'NM NS ZO PS PS PM PB',
    'ZO ZO PS PS PM PB PB',
    'ZO ZO PS PM PM PB PB',
  ]),
  kd: T([
    'PS NS NB NB NB NM PS',
    'PS NS NB NM NM NS ZO',
    'ZO NS NM NM NS NS ZO',
    'ZO NS NS NS NS NS ZO',
    'ZO ZO ZO ZO ZO ZO ZO',
    'PB NS PS PS PS PS PB',
    'PB PM PM PM PS PS PB',
  ]),
};

export const RULES_SYMMETRIC = {
  kp: T([
    'PB PB PB PB PM PM PS',
    'PB PB PB PM PS PS ZO',
    'PB PM PM PS ZO ZO NS',
    'ZO ZO ZO ZO ZO ZO ZO',
    'NS ZO ZO PS PM PM PB',
    'ZO PS PS PM PB PB PB',
    'PS PM PM PB PB PB PB',
  ]),
  ki: T([
    'ZO ZO ZO PS ZO ZO ZO',
    'ZO ZO PS PS PS ZO ZO',
    'PS PS PS PM PS PS PS',
    'PS PS PM PM PM PS PS',
    'PS PS PS PM PS PS PS',
    'ZO ZO PS PS PS ZO ZO',
    'ZO ZO ZO PS ZO ZO ZO',
  ]),
  kd: T([
    'ZO ZO NS NS ZO PS PS',
    'ZO ZO NS NS ZO PS PS',
    'PS ZO ZO NS PS PS PM',
    'PS PS ZO ZO ZO PS PS',
    'PM PS PS NS ZO ZO PS',
    'PS PS ZO NS NS ZO ZO',
    'PS PS ZO NS NS ZO ZO',
  ]),
};

export const RULE_SETS = { standard: RULES_STANDARD, symmetric: RULES_SYMMETRIC };

export const DEFAULT_FUZZY = {
  table: 'standard', // 'standard' = 표준 규칙표, 'symmetric' = 대칭 규칙표
  eMaxDeg: 10,      // 이 오차(°) 이상이면 '음/양으로 큼'(NB/PB)으로 봄
  ecMaxDeg: 100,    // 이 오차 변화율(°/s) 이상이면 NB/PB
  rangeP: 0.5,      // Kp 변경 범위 ±50%
  rangeI: 0.5,      // Ki 변경 범위 ±50%
  rangeD: 0.5,      // Kd 변경 범위 ±50%
};

/** 삼각형 멤버십 함수 7개 (양 끝은 바깥쪽으로 1 유지) */
function memberships(x) {
  const m = new Array(7);
  for (let k = 0; k < 7; k++) {
    const c = k - 3;
    if (k === 0 && x <= c) m[k] = 1;
    else if (k === 6 && x >= c) m[k] = 1;
    else m[k] = Math.max(0, 1 - Math.abs(x - c));
  }
  return m;
}

const clamp3 = (x) => Math.max(-3, Math.min(3, x));

/**
 * 오차(rad)와 오차 변화율(rad/s)을 넣으면 게인 변화 비율(-1 ~ +1) 3개를 돌려줌
 * 반환: { dp, di, dd, E, EC }  (E, EC = 정규화한 입력, 그래프·설명용)
 */
export function fuzzyAdjust(e, edot, f = DEFAULT_FUZZY) {
  const E = clamp3((e * 180 / Math.PI / f.eMaxDeg) * 3);
  const EC = clamp3((edot * 180 / Math.PI / f.ecMaxDeg) * 3);
  const R = RULE_SETS[f.table] || RULES_STANDARD;
  const me = memberships(E);
  const mc = memberships(EC);

  let sw = 0, sp = 0, si = 0, sd = 0;
  for (let i = 0; i < 7; i++) {
    if (me[i] === 0) continue;
    for (let j = 0; j < 7; j++) {
      if (mc[j] === 0) continue;
      const w = Math.min(me[i], mc[j]); // 규칙 적합도
      sw += w;
      sp += w * R.kp[i][j];
      si += w * R.ki[i][j];
      sd += w * R.kd[i][j];
    }
  }
  if (sw === 0) return { dp: 0, di: 0, dd: 0, E, EC };
  return { dp: sp / sw / 3, di: si / sw / 3, dd: sd / sw / 3, E, EC };
}
