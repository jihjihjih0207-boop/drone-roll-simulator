import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Drone, DRONE_SPEC } from './drone.js';
import { DEFAULT_PARAMS, DEFAULT_GAINS, DEFAULT_WIND, WIND_LABELS, SIM, computeDerived, simulate } from './physics.js';
import { DEFAULT_FUZZY, RULE_SETS, LABELS } from './fuzzy.js';
import { RollChart, GainChart } from './chart.js';
import { WindField } from './wind.js';
import { setupWindows, openWindow } from './ui.js';
import { DEFAULT_TUNING, physicsStart, autoTune, fairCompare, sizeStudy } from './tuning.js';
import { saveFile, stamp, toCSV, tableRows, runCSV, reportPNG } from './export.js';

const COLOR = { pid: '#38bdf8', fuzzy: '#4ade80' };

// ════════════════════════════════════════════════════════════════
// 1. 3D 장면
// ════════════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1720);
scene.fog = new THREE.Fog(0x0f1720, 6, 18);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.3;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.495;

scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x1a2230, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { near: 0.5, far: 10, left: -2, right: 2, top: 2, bottom: -2 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x16212c, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(40, 80, 0x2f4a63, 0x1f3242);
grid.position.y = 0.001;
scene.add(grid);

const HOVER_HEIGHT = 1.0;

/** 드론 위에 띄우는 이름표 */
function makeTag(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15,23,32,0.85)';
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 56, 16);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.32, 0.08, 1);
  sprite.renderOrder = 11;
  return sprite;
}

/** 드론 1대 + 목표 링 + 이름표 묶음 */
function makeUnit(tagText, color) {
  const drone = new Drone();
  drone.group.position.y = HOVER_HEIGHT;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.345, 64),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  drone.group.add(ring);
  const tag = makeTag(tagText, color);
  tag.position.y = 0.36;
  drone.group.add(tag);
  scene.add(drone.group);
  return { drone, tag };
}

const unitA = makeUnit('PID', COLOR.pid);          // 일반 모드의 드론, 비교 모드의 왼쪽(PID)
const unitB = makeUnit('Fuzzy-PID', COLOR.fuzzy);  // 비교 모드의 오른쪽(Fuzzy-PID)

const windField = new WindField();
scene.add(windField.lines);

// ════════════════════════════════════════════════════════════════
// 2. 입력 패널
// ════════════════════════════════════════════════════════════════
setupWindows();

const $ = (id) => document.getElementById(id);
const PARAM_KEYS = ['mass', 'motorMass', 'armLength', 'bodyWidth', 'bodyLength', 'propDiameter', 'maxThrust',
  'motorTau', 'sensorNoiseDeg', 'gyroNoiseDps', 'initialRollDeg'];
const GAIN_KEYS = ['kp', 'ki', 'kd'];
const WIND_KEYS = ['gustSpeed', 'gustStart', 'gustDuration', 'periodicAmp', 'periodicFreq',
  'turbIntensity', 'turbTime', 'seed', 'meanWind', 'cd', 'heightEff', 'direction', 'gustRate'];
const FUZZY_KEYS = ['fzRangeP', 'fzRangeI', 'fzRangeD', 'fzEMax', 'fzEcMax'];
const WIND_SHORT = { none: '없음', gust: '돌풍', periodic: '주기', random: '난류', composite: '복합', urban: '도시' };
const TABLE_SHORT = { standard: '표준', symmetric: '대칭' };

function fillDefaults() {
  PARAM_KEYS.forEach((k) => ($(k).value = DEFAULT_PARAMS[k]));
  GAIN_KEYS.forEach((k) => ($(k).value = DEFAULT_GAINS[k]));
  WIND_KEYS.forEach((k) => ($(k).value = DEFAULT_WIND[k]));
  $('windType').value = DEFAULT_WIND.type;
  $('fzTable').value = DEFAULT_FUZZY.table;
  $('fzRangeP').value = DEFAULT_FUZZY.rangeP * 100;
  $('fzRangeI').value = DEFAULT_FUZZY.rangeI * 100;
  $('fzRangeD').value = DEFAULT_FUZZY.rangeD * 100;
  $('fzEMax').value = DEFAULT_FUZZY.eMaxDeg;
  $('fzEcMax').value = DEFAULT_FUZZY.ecMaxDeg;
  $('tuneWn').value = DEFAULT_TUNING.wn;
  $('tuneZeta').value = DEFAULT_TUNING.zeta;
  $('tuneTarget').value = DEFAULT_TUNING.target;
  $('tuneOsMax').value = DEFAULT_TUNING.osMax;
  $('tuneSettleMax').value = DEFAULT_TUNING.settleMax;
  lastWindType = DEFAULT_WIND.type; // 기본값으로 돌아가면 '외란 없음'부터 다시 시작
  showWindFields();
  renderRuleTables();
}

const num = (id, fallback) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
};

function readParams() {
  const p = { ...DEFAULT_PARAMS };
  PARAM_KEYS.forEach((k) => (p[k] = num(k, DEFAULT_PARAMS[k])));
  return p;
}

function readGains() {
  const g = {};
  GAIN_KEYS.forEach((k) => (g[k] = num(k, 0)));
  return g;
}

function readWind() {
  const w = { ...DEFAULT_WIND, type: $('windType').value };
  WIND_KEYS.forEach((k) => (w[k] = num(k, DEFAULT_WIND[k])));
  return w;
}

function readFuzzy() {
  return {
    table: $('fzTable').value,
    rangeP: Math.max(num('fzRangeP', 50), 0) / 100,
    rangeI: Math.max(num('fzRangeI', 50), 0) / 100,
    rangeD: Math.max(num('fzRangeD', 50), 0) / 100,
    eMaxDeg: Math.max(num('fzEMax', 10), 0.1),
    ecMaxDeg: Math.max(num('fzEcMax', 100), 0.1),
  };
}

const mode = () => $('ctrlMode').value; // 'pid' | 'fuzzy' | 'compare'

/** 고른 외란 종류에 필요한 입력칸만 보여 줌 */
function showWindFields() {
  const type = $('windType').value;
  document.querySelectorAll('.wind-group').forEach((g) => {
    g.hidden = !g.dataset.show.split(' ').includes(type);
  });
}

/** 선택한 규칙표를 표로 그려 줌 (행: 오차 e, 열: 오차 변화율 ė) */
function renderRuleTables() {
  const R = RULE_SETS[$('fzTable').value];
  const names = { kp: 'ΔKp', ki: 'ΔKi', kd: 'ΔKd' };
  let html = '';
  for (const k of ['kp', 'ki', 'kd']) {
    html += `<h3>${names[k]} (행: e, 열: ė)</h3><table><tr><th></th>${LABELS.map((l) => `<th>${l}</th>`).join('')}</tr>`;
    R[k].forEach((row, i) => {
      html += `<tr><th>${LABELS[i]}</th>${row.map((v) => `<td class="${v > 0 ? 'p' : v < 0 ? 'n' : 'z'}">${LABELS[v + 3]}</td>`).join('')}</tr>`;
    });
    html += '</table>';
  }
  $('ruleTables').innerHTML = html;
}

/** 제어 방식에 맞춰 드론 배치, 카메라, 입력칸, 범례를 바꿈 */
function applyMode() {
  const m = mode();
  const compare = m === 'compare';
  $('fuzzyGroup').hidden = m === 'pid';

  unitA.drone.group.position.x = compare ? -0.6 : 0;
  unitB.drone.group.visible = compare;
  unitB.drone.group.position.x = 0.6;
  unitA.tag.visible = true;
  unitA.tag.material.map.dispose();
  const tagText = m === 'fuzzy' ? 'Fuzzy-PID' : 'PID';
  const newTag = makeTag(tagText, m === 'fuzzy' ? COLOR.fuzzy : COLOR.pid);
  unitA.tag.material = newTag.material;

  windField.setObstacles(compare
    ? [{ x: -0.6, y: HOVER_HEIGHT, z: 0, r: 0.32 }, { x: 0.6, y: HOVER_HEIGHT, z: 0, r: 0.32 }]
    : [{ x: 0, y: HOVER_HEIGHT, z: 0, r: 0.32 }]);

  // 카메라: 오른쪽 아래 그래프 패널에 가리지 않도록 드론이 화면 왼쪽 위에 오게 바라봄
  //         (비교 모드는 두 대가 다 보이게 조금 더 뒤에서)
  if (compare) {
    controls.target.set(0.45, HOVER_HEIGHT - 0.25, 0);
    camera.position.set(0.45, 1.75, 3.3);
  } else {
    controls.target.set(0.25, HOVER_HEIGHT - 0.12, 0);
    camera.position.set(0.25, 1.35, 1.75);
  }
  controls.update();

  updateLegend();
}

function updateLegend() {
  const m = mode();
  const items = [];
  if (m === 'compare') {
    items.push(['ln', 'PID'], ['ln fuzzy', 'Fuzzy-PID']);
  } else {
    items.push([m === 'fuzzy' ? 'ln fuzzy' : 'ln cur', '현재 실험'], ['ln ghost', '이전 실험']);
  }
  items.push(['ln wind', '풍속 m/s (오른쪽 축)'], ['band', '정착 범위 ±2°']);
  $('legend').innerHTML = items
    .map(([cls, text]) => `<span><i class="${cls}"${cls === 'ln' ? ` style="background:${COLOR.pid}"` : ''}></i>${text}</span>`)
    .join('');
}

function updateDerived() {
  const p = readParams();
  const w = readWind();
  const d = computeDerived(p, w);
  $('dI').textContent = `${d.I.toFixed(5)} kg·m²`;
  $('dIparts').textContent = `${d.I_body.toFixed(5)} / ${d.I_motors.toFixed(5)}`;
  $('dHover').textContent = `${d.hover.toFixed(2)} N`;
  $('dTau').textContent = `${d.maxTorque.toFixed(2)} N·m`;
  $('dArea').textContent = `${d.sideArea.toFixed(4)} m²`;
  $('dWindTau').textContent = `${(d.windCoef * 100).toFixed(3)} N·m`;
  $('warnings').textContent = d.warnings.join(' ');
  $('btnStart').disabled = d.warnings.length > 0;

  // 3D 드론 크기를 입력한 모터 거리에 맞춰 조절
  const s = p.armLength / DRONE_SPEC.armLength;
  unitA.drone.body.scale.setScalar(s);
  unitB.drone.body.scale.setScalar(s);

  // 시작 전이면 초기 기울기를 미리 보여 줌
  if (!state.runs) {
    showPose(unitA.drone, p.initialRollDeg, null, p);
    showPose(unitB.drone, p.initialRollDeg, null, p);
  }
  return { p, w, d };
}

// ════════════════════════════════════════════════════════════════
// 3. 시뮬레이션 실행과 재생
// ════════════════════════════════════════════════════════════════
const chart = new RollChart($('chart'), { band: SIM.settleBandDeg });
const gainChart = new GainChart($('gainChart'));
const state = {
  runs: null,     // [{ label, color, res, unit }]
  simTime: 0,     // 재생 중인 시뮬레이션 시각
  playing: false,
  finished: false,
  runCount: 0,
};

function showPose(drone, rollDeg, thrusts, p) {
  drone.setAttitude(THREE.MathUtils.degToRad(rollDeg), 0, 0);
  if (thrusts) drone.setThrusts(thrusts.map((f) => f / p.maxThrust));
  else drone.setThrusts([0.5, 0.5, 0.5, 0.5]);
}

const ratioSeries = (arr, base, n) => {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = base !== 0 ? arr[i] / base : 1;
  return out;
};
const mean = (arr, n) => { let s = 0; for (let i = 0; i <= n; i++) s += arr[i]; return s / (n + 1); };

function startRun() {
  const { p, w, d } = updateDerived();
  if (d.warnings.length) return;
  const g = readGains();
  const fz = readFuzzy();
  const m = mode();
  const fuzzyLabel = `Fuzzy-PID(${TABLE_SHORT[fz.table]})`;

  const runs = [];
  if (m === 'pid' || m === 'compare') {
    runs.push({ label: 'PID', color: COLOR.pid, res: simulate(p, g, { wind: w }), unit: unitA });
  }
  if (m === 'fuzzy' || m === 'compare') {
    runs.push({ label: fuzzyLabel, color: COLOR.fuzzy, res: simulate(p, g, { wind: w, fuzzy: fz }), unit: m === 'compare' ? unitB : unitA });
  }

  state.runs = runs;
  state.simTime = 0;
  state.playing = true;
  state.finished = false;

  const windObj = w.type === 'none' ? null : { t: runs[0].res.t, v: runs[0].res.windSpeed, n: runs[0].res.n };
  const asRun = (r) => ({ t: r.res.t, y: r.res.thetaDeg, n: r.res.n });
  if (m === 'compare') chart.setCompare(asRun(runs[0]), asRun(runs[1]), SIM.duration, windObj);
  else chart.setRun(asRun(runs[0]), SIM.duration, windObj, runs[0].res.fuzzy ? 'fuzzy' : 'pid');

  // Fuzzy가 있으면 게인 변화 그래프 준비
  const fr = runs.find((r) => r.res.fuzzy);
  $('gainBlock').hidden = !fr;
  if (fr) {
    const r = fr.res;
    const series = { t: r.t, n: r.n, p: ratioSeries(r.kpT, g.kp, r.n), i: ratioSeries(r.kiT, g.ki, r.n), d: ratioSeries(r.kdT, g.kd, r.n) };
    gainChart.setRun(series, SIM.duration, Math.max(fz.rangeP, fz.rangeI, fz.rangeD));
    $('gmP').textContent = `평균 ×${mean(series.p, r.n).toFixed(2)}`;
    $('gmI').textContent = `평균 ×${mean(series.i, r.n).toFixed(2)}`;
    $('gmD').textContent = `평균 ×${mean(series.d, r.n).toFixed(2)}`;
  }

  $('mSettleLabel').textContent = w.type === 'gust' ? '정착 (돌풍 시작부터)' : '정착시간 (±2°)';
  showMetrics(false);
  $('btnPause').textContent = '⏸ 일시정지';
}

function finishRun() {
  if (!state.runs || state.finished) return;
  state.finished = true;
  state.playing = false;
  state.simTime = Math.max(...state.runs.map((r) => r.res.t[r.res.n]));
  showMetrics(true);
  state.runs.forEach(addRecord);
}

function fmtSettle(m) {
  if (m.crashed) return '전복';
  if (m.settle === 'na') return '해당 없음';
  if (m.settle === null) return '정착 안 됨';
  if (m.settleNote) return m.settleNote;
  return `${m.settle.toFixed(2)} s`;
}
const fmtOvershoot = (m) => (m.overshoot === null ? '해당 없음' : `${m.overshoot.toFixed(2)}°`);

/** 평가지표 표: 비교 모드에서는 더 좋은 값(작은 값)을 초록색으로 */
function showMetrics(done) {
  const body = $('metricsBody');
  body.innerHTML = '';
  if (!state.runs) return;
  const ms = state.runs.map((r) => r.res.metrics);
  const best = (key) => {
    const vals = ms.map((m) => (typeof m[key] === 'number' && !m.crashed ? m[key] : Infinity));
    const min = Math.min(...vals);
    return ms.length > 1 && Number.isFinite(min) && vals.filter((v) => v === min).length === 1 ? vals.indexOf(min) : -1;
  };
  const bMax = best('maxErr'), bOs = best('overshoot'), bSet = best('settle'), bRmse = best('rmse');

  state.runs.forEach((r, k) => {
    const m = r.res.metrics;
    const tr = document.createElement('tr');
    const cells = done
      ? [
        [`<span class="tag" style="background:${r.color}"></span>${r.label}`, ''],
        [`${m.maxErr.toFixed(2)}°`, k === bMax ? 'better' : ''],
        [fmtOvershoot(m), m.overshoot === null ? 'na' : k === bOs ? 'better' : ''],
        [fmtSettle(m), m.crashed || m.settle === null ? 'bad' : m.settle === 'na' || m.settleNote ? 'na' : k === bSet ? 'better' : ''],
        [`${m.rmse.toFixed(2)}°`, k === bRmse ? 'better' : ''],
      ]
      : [[`<span class="tag" style="background:${r.color}"></span>${r.label}`, ''], ['…', ''], ['…', ''], ['…', ''], ['…', '']];
    cells.forEach(([html, cls]) => {
      const td = document.createElement('td');
      td.innerHTML = html;
      if (cls) td.className = cls;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function addRecord(r) {
  state.runCount += 1;
  const m = r.res.metrics, g = r.res.gains;
  const tr = document.createElement('tr');
  [
    state.runCount, r.label, WIND_SHORT[r.res.wind.type], g.kp, g.ki, g.kd, `${r.res.params.initialRollDeg}°`,
    `${m.maxErr.toFixed(2)}°`, fmtOvershoot(m), fmtSettle(m), `${m.rmse.toFixed(2)}°`,
  ].forEach((v) => {
    const td = document.createElement('td');
    td.textContent = v;
    tr.appendChild(td);
  });
  $('records').prepend(tr); // 최신 실험이 맨 위
}

// 버튼과 입력 연결
$('btnStart').addEventListener('click', startRun);
$('btnPause').addEventListener('click', () => {
  if (!state.runs || state.finished) return;
  state.playing = !state.playing;
  $('btnPause').textContent = state.playing ? '⏸ 일시정지' : '▶ 계속';
});
$('btnSkip').addEventListener('click', () => {
  if (!state.runs) startRun();
  finishRun();
});
$('btnDefault').addEventListener('click', () => {
  // 입력값만 기본값으로 되돌림 (그래프와 실험 기록은 남겨 둠)
  fillDefaults();
  state.runs = null;
  state.finished = false;
  state.playing = false;
  updateDerived();
});
$('btnClear').addEventListener('click', (e) => {
  e.preventDefault();
  $('records').innerHTML = '';
  state.runCount = 0;
});

function onInputChange() {
  // 값을 바꾸면 이전 결과는 끝난 것으로 보고 새 초기 자세를 보여 줌
  if (state.runs && !state.playing) state.runs = null;
  updateDerived();
}
[...PARAM_KEYS, ...GAIN_KEYS, ...WIND_KEYS, ...FUZZY_KEYS].forEach((k) => $(k).addEventListener('input', onInputChange));

let lastWindType = DEFAULT_WIND.type;
$('windType').addEventListener('change', () => {
  const type = $('windType').value;
  // 외란 실험은 수평(0°)에서 시작해야 바람만의 영향을 볼 수 있음
  if (lastWindType === 'none' && type !== 'none') $('initialRollDeg').value = 0;
  if (lastWindType !== 'none' && type === 'none') $('initialRollDeg').value = DEFAULT_PARAMS.initialRollDeg;
  lastWindType = type;
  showWindFields();
  onInputChange();
});
$('ctrlMode').addEventListener('change', () => { state.runs = null; applyMode(); onInputChange(); });
$('fzTable').addEventListener('change', () => { renderRuleTables(); onInputChange(); });

['showThrust', 'showAxes', 'showLabels', 'showWind'].forEach((k) => $(k).addEventListener('change', applyVisibility));
function applyVisibility() {
  const vis = { thrust: $('showThrust').checked, axes: $('showAxes').checked, labels: $('showLabels').checked };
  unitA.drone.setVisibility(vis);
  unitB.drone.setVisibility(vis);
  windField.lines.visible = $('showWind').checked;
}

// ════════════════════════════════════════════════════════════════
// 4. PID 자동 산출 (⑦)
// ════════════════════════════════════════════════════════════════
const fmtG = (x) => (x === 0 ? '0' : +x.toPrecision(3));
let startGains = null;

function readTuning() {
  return {
    wn: Math.max(num('tuneWn', DEFAULT_TUNING.wn), 0.1),
    zeta: Math.max(num('tuneZeta', DEFAULT_TUNING.zeta), 0.05),
    target: $('tuneTarget').value,
    osMax: Math.max(num('tuneOsMax', DEFAULT_TUNING.osMax), 0),
    settleMax: Math.max(num('tuneSettleMax', DEFAULT_TUNING.settleMax), 0.01),
  };
}

/** 게인을 입력칸에 넣고 반짝 표시 */
function applyGains(g) {
  $('kp').value = fmtG(g.kp);
  $('ki').value = fmtG(g.ki);
  $('kd').value = fmtG(g.kd);
  ['kp', 'ki', 'kd'].forEach((k) => {
    $(k).classList.remove('flash');
    void $(k).offsetWidth;
    $(k).classList.add('flash');
  });
  onInputChange();
}

function showAnalysis(title, html) {
  $('analysisTitle').textContent = title;
  $('analysisBody').innerHTML = html + '<div class="save-row"><button class="tiny" data-export="analysis">⤓ 이 표를 CSV로 저장</button></div>';
  openWindow($('analysis'));
}

const tuneButtons = ['btnTune', 'btnFair', 'btnSize', 'btnStartGain'];
function setBusy(busy) {
  tuneButtons.forEach((id) => ($(id).disabled = busy));
  $('tuneProgress').hidden = !busy;
}
function progress(f, msg) {
  $('tuneBar').style.width = `${(f * 100).toFixed(0)}%`;
  $('tuneMsg').textContent = msg;
}

$('btnStartGain').addEventListener('click', () => {
  const t = readTuning();
  startGains = physicsStart(readParams(), t.wn, t.zeta);
  $('startGains').textContent = `Kp ${fmtG(startGains.kp)} · Ki ${fmtG(startGains.ki)} · Kd ${fmtG(startGains.kd)}`;
  $('btnApplyStart').disabled = false;
});
$('btnApplyStart').addEventListener('click', () => startGains && applyGains(startGains));

$('btnTune').addEventListener('click', async () => {
  setBusy(true);
  const t = readTuning();
  const p = readParams();
  const res = await autoTune(p, readWind(), t, progress);
  setBusy(false);

  const s = res.start;
  const cur = readGains();
  let html = `<p>관성모멘트 I = ${s.I.toFixed(5)} kg·m², 목표 ωn = ${t.wn} rad/s, ζ = ${t.zeta}<br>
    물리식 시작값: <b>Kp ${fmtG(s.kp)} · Ki ${fmtG(s.ki)} · Kd ${fmtG(s.kd)}</b></p>
    <p>${res.tested}개 조합을 계산했고, 그중 <b>${res.passed}개</b>가 기준(전복 없음, 오버슈트 ≤ ${t.osMax}°, 정착 ≤ ${t.settleMax} s)을 통과했어요.</p>
    <p class="note">대상: ${res.scenarios.map((x) => x.name).join(', ')} · 점수 = 대상 실험들의 평균 RMSE (작을수록 좋음)</p>`;
  if (!res.ranked.length) {
    html += '<p>기준을 통과한 조합이 없어요. 오버슈트·정착시간 한도를 늘리거나 목표 ωn을 바꿔 보세요.</p>';
  } else {
    html += `<table><tr><th>순위</th><th>Kp</th><th>Ki</th><th>Kd</th><th>평균 RMSE</th><th>오버슈트</th><th>정착</th><th>모터 출렁임</th><th></th></tr>`;
    res.ranked.slice(0, 10).forEach((c, k) => {
      const g = c.gains;
      html += `<tr><td>${k + 1}</td><td>${fmtG(g.kp)}</td><td>${fmtG(g.ki)}</td><td>${fmtG(g.kd)}</td>
        <td class="${k === 0 ? 'best' : ''}">${c.meanRmse.toFixed(3)}°</td>
        <td>${c.os === null ? '–' : c.os.toFixed(2) + '°'}</td>
        <td>${c.settleNa ? '–' : c.settle === null ? '안 됨' : c.settle.toFixed(2) + ' s'}</td>
        <td>${c.motor.toFixed(3)} N</td>
        <td><button class="tiny" data-apply="${g.kp},${g.ki},${g.kd}">적용</button></td></tr>`;
    });
    html += '</table>';
    const b = res.ranked[0].gains;
    html += `<p class="note">1위는 시작값 대비 Kp ×${(b.kp / s.kp).toFixed(2)}, Ki ×${(b.ki / s.ki).toFixed(2)}, Kd ×${(b.kd / s.kd).toFixed(2)}예요.
      지금 입력칸 게인(Kp ${fmtG(cur.kp)} · Ki ${fmtG(cur.ki)} · Kd ${fmtG(cur.kd)})과 비교하려면 '적용' 후 '공정 비교'를 눌러 보세요.
      모터 출렁임은 추력 명령이 흔들리는 정도로, 크면 실제 드론에서 떨림·발열이 커져요.</p>`;
  }
  showAnalysis('자동 탐색 결과', html);
});

$('btnFair').addEventListener('click', () => {
  setBusy(true);
  progress(0.5, '외란 5종 × 제어기 3종 계산 중');
  setTimeout(() => {
    const g = readGains();
    const fc = fairCompare(readParams(), readWind(), g, readFuzzy());
    setBusy(false);
    let html = `<p>기본 게인 <b>Kp ${fmtG(g.kp)} · Ki ${fmtG(g.ki)} · Kd ${fmtG(g.kd)}</b>로 세 제어기를 같은 조건에서 비교했어요.
      칸 = RMSE (작은 글씨: 최대 오차), 초록색 = 그 조건에서 가장 좋은 값</p>`;
    html += `<table><tr><th class="l">조건</th>${fc.ctrls.map((c) => `<th>${c.label}</th>`).join('')}</tr>`;
    const sums = fc.ctrls.map(() => 0);
    fc.rows.forEach((row) => {
      const vals = row.cells.map((m) => (m.crashed ? Infinity : m.rmse));
      const min = Math.min(...vals);
      html += `<tr><td class="l">${row.name}</td>${row.cells.map((m, k) => {
        sums[k] += m.rmse;
        return `<td class="${vals[k] === min ? 'best' : ''}">${m.crashed ? '전복' : m.rmse.toFixed(3) + '°'}<br><small>${m.maxErr.toFixed(2)}°</small></td>`;
      }).join('')}</tr>`;
    });
    const means = sums.map((x) => x / fc.rows.length);
    const minMean = Math.min(...means);
    html += `<tr><td class="l"><b>평균</b></td>${means.map((m) => `<td class="${m === minMean ? 'best' : ''}"><b>${m.toFixed(3)}°</b></td>`).join('')}</tr></table>`;
    const gap = ((means[0] - Math.min(means[1], means[2])) / means[0]) * 100;
    html += `<p class="note">${Math.abs(gap) < 1
      ? `세 제어기의 평균 RMSE 차이가 1% 미만으로 거의 같아요.`
      : gap > 0
        ? `Fuzzy가 PID보다 평균 RMSE를 최대 ${gap.toFixed(1)}% 줄였어요.`
        : `PID가 두 Fuzzy보다 평균 RMSE가 ${(-gap).toFixed(1)}% 이상 작아요.`}
      기본 게인이 최적이 아닐수록 Fuzzy의 보정 효과가 크게 나타나요. 자동 탐색으로 찾은 최적 게인으로도 비교해 보세요.</p>`;
    showAnalysis('공정 비교 결과', html);
  }, 30);
});

$('btnSize').addEventListener('click', async () => {
  setBusy(true);
  const t = { ...readTuning(), target: 'all' };
  const res = await sizeStudy(readParams(), readWind(), t, progress);
  setBusy(false);
  let html = `<p>같은 목표 반응(ωn ${t.wn}, ζ ${t.zeta})과 같은 기준으로, 크기만 다른 드론 3대를 각각 자동 탐색했어요.</p>
    <table><tr><th class="l">크기</th><th>질량</th><th>L</th><th>관성모멘트 I</th><th>Kp</th><th>Ki</th><th>Kd</th><th>Kd/Kp</th><th>Ki/Kp</th><th>평균 RMSE</th></tr>`;
  res.forEach((r) => {
    const b = r.best;
    html += `<tr><td class="l">${r.name}</td><td>${r.p.mass} kg</td><td>${r.p.armLength} m</td><td>${r.I.toFixed(5)}</td>
      ${b ? `<td>${fmtG(b.gains.kp)}</td><td>${fmtG(b.gains.ki)}</td><td>${fmtG(b.gains.kd)}</td>
      <td>${(b.gains.kd / b.gains.kp).toFixed(3)}</td><td>${(b.gains.ki / b.gains.kp).toFixed(2)}</td><td>${b.meanRmse.toFixed(3)}°</td>`
    : '<td colspan="6">기준 통과 조합 없음</td>'}</tr>`;
  });
  html += `</table><p class="note">관성모멘트 I가 커질수록 같은 반응을 내는 데 필요한 게인이 커져요 (Kp ∝ I). 
    보고서의 "드론 크기와 질량에 따라 PID 값이 크게 달라진다"를 확인하는 실험이에요. 
    각 크기의 기체 값은 일반적인 예시값이라, 실제 드론과 다를 수 있어요.</p>`;
  showAnalysis('드론 크기별 최적 게인', html);
});

// 분석 표의 '적용' 버튼과 'CSV로 저장' 버튼
$('analysisBody').addEventListener('click', (e) => {
  if (e.target.closest('button[data-export]')) { saveAnalysisCSV(); return; }
  const btn = e.target.closest('button[data-apply]');
  if (!btn) return;
  const [kp, ki, kd] = btn.dataset.apply.split(',').map(Number);
  applyGains({ kp, ki, kd });
  btn.textContent = '적용됨';
});

// ════════════════════════════════════════════════════════════════
// 5. 결과 저장 (보고서용 그림·데이터)
// ════════════════════════════════════════════════════════════════
const WIND_FILE = { none: 'nowind', gust: 'gust', periodic: 'periodic', random: 'turbulence', composite: 'composite' };

/** 실험 조건 (CSV 맨 위와 그림 부제목에 씀) */
function runInfo(runs) {
  const r = runs[0].res;
  const p = r.params, w = r.wind, g = r.gains, d = r.derived;
  const info = {
    '제어기': runs.map((x) => x.label).join(' vs '),
    'Kp / Ki / Kd (기본값)': `${g.kp} / ${g.ki} / ${g.kd}`,
    '외란': WIND_LABELS[w.type],
  };
  if (w.type !== 'none') info['풍향(°)'] = w.direction;
  if (['gust', 'composite', 'urban'].includes(w.type)) info['돌풍 최대 풍속(m/s) / 시작(s) / 지속(s)'] = `${w.gustSpeed} / ${w.gustStart} / ${w.gustDuration}`;
  if (w.type === 'urban') info['돌풍 빈도(회/s)'] = w.gustRate;
  if (w.type === 'periodic') info['주기적 외란 진폭(m/s) / 주파수(Hz)'] = `${w.periodicAmp} / ${w.periodicFreq}`;
  if (['random', 'composite', 'urban'].includes(w.type)) info['난류 세기(m/s) / 상관 시간(s) / 시드'] = `${w.turbIntensity} / ${w.turbTime} / ${w.seed}`;
  if (['composite', 'urban'].includes(w.type)) info['일정한 바람(m/s)'] = w.meanWind;
  if (w.type !== 'none') info['항력계수 Cd / 유효 높이 h(m) (가정값)'] = `${w.cd} / ${w.heightEff}`;
  const fz = runs.find((x) => x.res.fuzzy)?.res.fuzzy;
  if (fz) {
    info['Fuzzy 규칙표'] = fz.table === 'symmetric' ? '대칭 규칙표' : '표준 규칙표';
    info['Fuzzy 변경 범위 Kp/Ki/Kd(%)'] = `±${fz.rangeP * 100} / ±${fz.rangeI * 100} / ±${fz.rangeD * 100}`;
    info['Fuzzy 오차 기준(°) / 변화율 기준(°/s)'] = `${fz.eMaxDeg} / ${fz.ecMaxDeg}`;
  }
  Object.assign(info, {
    '초기 Roll 각(°)': p.initialRollDeg,
    '전체 질량(kg)': p.mass,
    '모터 1개 질량(kg)': p.motorMass,
    '모터 중심 거리 L(m)': p.armLength,
    '몸체 가로 / 세로 / 높이(m)': `${p.bodyWidth} / ${p.bodyLength} / ${p.bodyHeight}`,
    '프로펠러 지름(m)': p.propDiameter,
    '모터 최대 추력(N)': p.maxThrust,
    '모터 반응 시간(s)': p.motorTau,
    '각도 센서 잡음(°) / 자이로 잡음(°/s)': `${p.sensorNoiseDeg} / ${p.gyroNoiseDps}`,
    '관성모멘트 I(kg·m²)': d.I.toFixed(6),
    '제자리 비행 추력 1개(N)': d.hover.toFixed(3),
    '계산 간격(s) / 시간(s)': `${r.sim.dt} / ${r.sim.duration}`,
    '정착 기준': `±${r.sim.settleBandDeg}°`,
  });
  return info;
}

function fileBase(runs) {
  const r = runs[0].res;
  const ctrl = runs.length > 1 ? 'compare' : r.fuzzy ? 'fuzzy' : 'pid';
  return `roll_${WIND_FILE[r.wind.type]}_${ctrl}_${stamp()}`;
}

/** 저장 버튼 공통: 실험이 끝났는지 확인하고, 저장 중 표시 */
async function withRuns(btn, job) {
  if (!state.runs) { flashMsg('먼저 ▶ 시작이나 ⏭ 결과 바로 보기로 실험을 해 주세요.'); return; }
  if (!state.finished) finishRun(); // 재생 중이면 끝까지 계산된 결과로 저장
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '저장 중…';
  try {
    const ok = await job(state.runs);
    flashMsg(ok ? '저장했어요. 다운로드 폴더를 확인하세요.' : '저장을 취소했어요.');
  } catch (err) {
    console.error(err);
    flashMsg(`저장하지 못했어요: ${err.message || err.code || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

let msgTimer = null;
function flashMsg(text) {
  $('saveMsg').textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => ($('saveMsg').textContent = ''), 5000);
}

const fmtM = (m) => [
  `${m.maxErr.toFixed(2)}°`, fmtOvershoot(m), fmtSettle(m), `${m.rmse.toFixed(2)}°`,
];

$('btnPng').addEventListener('click', (e) => withRuns(e.currentTarget, async (runs) => {
  const r = runs[0].res;
  const g = r.gains;
  const compare = runs.length > 1;
  const legend = compare
    ? [{ color: 'pid', text: 'PID', width: 4 }, { color: 'fuzzy', text: runs[1].label, dash: [9, 6] }]
    : [{ color: r.fuzzy ? 'fuzzy' : 'pid', text: runs[0].label }];
  if (r.wind.type !== 'none') legend.push({ color: 'wind', text: '풍속 (오른쪽 축)', width: 2 });
  legend.push({ band: true, text: `정착 범위 ±${r.sim.settleBandDeg}°` });

  const fr = runs.find((x) => x.res.fuzzy);
  const sub = [`Kp ${g.kp} · Ki ${g.ki} · Kd ${g.kd}`, `초기 Roll ${r.params.initialRollDeg}°`];
  if (r.wind.type !== 'none') sub.push(`풍향 ${r.wind.direction}°`);
  sub.push(`질량 ${r.params.mass} kg · L ${r.params.armLength} m · I ${r.derived.I.toFixed(5)} kg·m²`);

  const blob = await reportPNG({
    rollChart: chart,
    gainChart: fr ? gainChart : null,
    title: `Roll 각도 응답 — ${WIND_LABELS[r.wind.type]} · ${compare ? 'PID vs ' + runs[1].label : runs[0].label}`,
    subtitle: sub.join('   |   '),
    legend,
    gainLegend: fr ? [
      { color: 'kp', text: 'Kp 비율', width: 2.5 }, { color: 'ki', text: 'Ki 비율', width: 2.5 }, { color: 'kd', text: 'Kd 비율', width: 2.5 },
      { color: '#9ca3af', text: `(${fr.label}이 바꾼 게인 ÷ 기본 게인)`, width: 0 },
    ] : null,
    metrics: {
      head: ['제어기', '최대 오차', '오버슈트', r.wind.type === 'gust' ? '정착 (돌풍 시작부터)' : '정착시간 (±2°)', 'RMSE'],
      rows: runs.map((x) => [x.label, ...fmtM(x.res.metrics)]),
    },
  });
  return saveFile(`${fileBase(runs)}.png`, blob);
}));

$('btnCsv').addEventListener('click', (e) => withRuns(e.currentTarget, async (runs) => (
  saveFile(`${fileBase(runs)}.csv`, runCSV(runs, runInfo(runs)))
)));

$('btnRecCsv').addEventListener('click', async (e) => {
  const rows = tableRows($('records').closest('table'));
  if (rows.length <= 1) { flashMsg('실험 기록이 아직 없어요.'); return; }
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const ok = await saveFile(`experiment_records_${stamp()}.csv`, toCSV(rows));
    flashMsg(ok ? '저장했어요. 다운로드 폴더를 확인하세요.' : '저장을 취소했어요.');
  } catch (err) {
    flashMsg(`저장하지 못했어요: ${err.message || err.code || err}`);
  } finally { btn.disabled = false; }
});

async function saveAnalysisCSV() {
  const body = $('analysisBody');
  const rows = [[$('analysisTitle').textContent], []];
  body.querySelectorAll(':scope > p, :scope > table').forEach((el) => {
    if (el.tagName === 'P') rows.push([el.textContent.replace(/\s+/g, ' ').trim()]);
    else { rows.push(...tableRows(el)); rows.push([]); }
  });
  const name = { '자동 탐색 결과': 'autotune', '공정 비교 결과': 'fair_compare', '드론 크기별 최적 게인': 'size_study' }[$('analysisTitle').textContent] || 'analysis';
  try {
    const ok = await saveFile(`${name}_${stamp()}.csv`, toCSV(rows));
    flashMsg(ok ? '분석 표를 저장했어요. 다운로드 폴더를 확인하세요.' : '저장을 취소했어요.');
  } catch (err) {
    flashMsg(`저장하지 못했어요: ${err.message || err.code || err}`);
  }
}

fillDefaults();
applyMode();
applyVisibility();
updateDerived();
chart.draw();
gainChart.draw();

// ════════════════════════════════════════════════════════════════
// 6. 애니메이션 루프
// ════════════════════════════════════════════════════════════════
const clock = new THREE.Clock();

function animate() {
  const frameDt = Math.min(clock.getDelta(), 0.05);
  const runs = state.runs;
  const speed = parseFloat($('speed').value);
  let windNow = 0;
  let turbulence = 0;
  let direction = 0;

  if (runs) {
    const end = Math.max(...runs.map((r) => r.res.t[r.res.n]));
    if (state.playing) {
      state.simTime += frameDt * speed;
      if (state.simTime >= end) finishRun();
    }
    const i0 = Math.floor(state.simTime / SIM.dt);
    const texts = [];
    runs.forEach((r) => {
      const res = r.res;
      const i = Math.min(i0, res.n);
      showPose(r.unit.drone, res.thetaDeg[i], [res.F[0][i], res.F[1][i], res.F[2][i], res.F[3][i]], res.params);
      texts.push(runs.length > 1 ? `${r.label.startsWith('PID') ? 'PID' : 'Fuzzy'} θ = ${res.thetaDeg[i].toFixed(1)}°` : `θ = ${res.thetaDeg[i].toFixed(1)}°`);
    });
    const r0 = runs[0].res;
    const i = Math.min(i0, r0.n);
    chart.setProgress(i0);
    gainChart.setProgress(i0);

    windNow = r0.windSpeed[i];
    direction = r0.wind.direction;
    if (['random', 'composite', 'urban'].includes(r0.wind.type)) turbulence = Math.min(r0.wind.turbIntensity / 6, 1);
    const arrow = windNow > 0.05 ? ' →' : windNow < -0.05 ? ' ←' : '';
    const windText = r0.wind.type === 'none' ? '' : ` · 바람 ${Math.abs(windNow).toFixed(1)} m/s${arrow}`;
    $('live').textContent = `t = ${r0.t[i].toFixed(2)} s · ${texts.join(' · ')}${windText}`;
  } else {
    $('live').textContent = `t = 0.00 s · θ = ${num('initialRollDeg', 0).toFixed(1)}° (시작 전)`;
  }

  // 바람 줄기: 재생 속도에 맞춰 흐름 (일시정지 중에는 멈춤)
  windField.set(windNow, turbulence, direction);
  if ($('showWind').checked) windField.update(state.playing ? frameDt * speed : 0);

  unitA.drone.update(frameDt, 0.7);
  if (unitB.drone.group.visible) unitB.drone.update(frameDt, 0.7);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
