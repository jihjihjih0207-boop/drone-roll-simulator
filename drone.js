import * as THREE from 'three';

/*
 * 쿼드콥터(X자형) 3D 모델
 *
 * 좌표계 (Three.js 기준)
 *   +Y : 위쪽
 *   -Z : 기체 앞쪽 (빨간 LED 방향)
 *   +X : 기체 오른쪽
 *
 * 모터 번호 (보고서의 표와 같게 맞춤, 위에서 내려다본 모습)
 *
 *        앞(-Z)
 *    m1 ↻      m2 ↺
 *        \    /
 *         [몸체]
 *        /    \
 *    m4 ↺      m3 ↻
 *        뒤(+Z)
 *
 *   m1, m3 : 시계 방향(CW)   / m2, m4 : 반시계 방향(CCW)
 *   → 대각선 모터끼리 같은 방향으로 돌아서 반작용 토크가 상쇄된다.
 *
 * 자세각 부호 (항공 분야 관례)
 *   Roll  + : 오른쪽이 내려감
 *   Pitch + : 기수(앞)가 올라감
 *   Yaw   + : 위에서 볼 때 시계 방향(우회전)
 */

// ── 기체 치수 (단위: m, 450mm급 프레임 기준) ──────────────────────
export const DRONE_SPEC = {
  armLength: 0.225,      // 기체 중심 ~ 모터 중심 거리 L
  bodySize: 0.12,        // 몸체 가로·세로
  propDiameter: 0.254,   // 10인치 프로펠러
  motorRadius: 0.022,
  motorHeight: 0.03,
};

const COLORS = {
  carbon: 0x2b3542,
  carbonLight: 0x4b5563,
  motor: 0x9ca3af,
  battery: 0x2563eb,
  propCW: 0xef4444,
  propCCW: 0x22c55e,
  frontLed: 0xff3030,
  rearLed: 0x34d399,
};

// 모터 정보: 위치 방향(x, z 부호)과 회전 방향(+1 = CW, -1 = CCW)
const MOTORS = [
  { name: 'm1', x: -1, z: -1, dir: +1 }, // 앞-왼쪽
  { name: 'm2', x: +1, z: -1, dir: -1 }, // 앞-오른쪽
  { name: 'm3', x: +1, z: +1, dir: +1 }, // 뒤-오른쪽
  { name: 'm4', x: -1, z: +1, dir: -1 }, // 뒤-왼쪽
];

export class Drone {
  constructor() {
    this.group = new THREE.Group();     // 위치(이동)용
    this.body = new THREE.Group();      // 자세(회전)용 → 이 안에 모든 부품
    this.body.rotation.order = 'YXZ';   // Yaw → Pitch → Roll 순서로 회전
    this.group.add(this.body);

    this.props = [];
    this.thrustArrows = [];
    this.labels = [];
    this.thrusts = [0.5, 0.5, 0.5, 0.5]; // 0~1 (모터별 추력 비율)

    this.#buildFrame();
    this.#buildMotors();
    this.#buildExtras();

    this.axes = new THREE.AxesHelper(0.35);
    this.axes.position.y = 0.06;
    this.body.add(this.axes);

    this.body.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    // 반투명 회전 원판은 그림자를 만들지 않음
    this.props.forEach((p) => { p.userData.disc.castShadow = false; p.userData.disc.receiveShadow = false; });
  }

  // ── 몸체와 팔 ──────────────────────────────────────────────────
  #buildFrame() {
    const { armLength, bodySize } = DRONE_SPEC;
    const carbon = new THREE.MeshStandardMaterial({ color: COLORS.carbon, roughness: 0.55, metalness: 0.3 });
    const carbonLight = new THREE.MeshStandardMaterial({ color: COLORS.carbonLight, roughness: 0.5, metalness: 0.3 });

    // 위·아래 판
    const plateGeo = new THREE.BoxGeometry(bodySize, 0.006, bodySize * 1.25);
    const bottom = new THREE.Mesh(plateGeo, carbon);
    const top = new THREE.Mesh(plateGeo, carbon);
    top.position.y = 0.035;
    this.body.add(bottom, top);

    // 판 사이 기둥
    const standoffGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.035, 8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const s = new THREE.Mesh(standoffGeo, carbonLight);
      s.position.set(sx * bodySize * 0.4, 0.0175, sz * bodySize * 0.5);
      this.body.add(s);
    }

    // 비행 제어기(FC) 보드
    const fc = new THREE.Mesh(
      new THREE.BoxGeometry(0.036, 0.008, 0.036),
      new THREE.MeshStandardMaterial({ color: 0x065f46, roughness: 0.6 }),
    );
    fc.position.y = 0.018;
    this.body.add(fc);

    // 팔 4개 (X자)
    const armGeo = new THREE.BoxGeometry(0.022, 0.012, armLength);
    for (const m of MOTORS) {
      const arm = new THREE.Mesh(armGeo, carbon);
      // 팔의 중심을 기체 중심과 모터 사이 중간 지점에 두고, 모터 방향으로 회전
      arm.position.set((m.x * armLength * 0.5) / Math.SQRT2, 0.003, (m.z * armLength * 0.5) / Math.SQRT2);
      arm.rotation.y = Math.atan2(m.x, m.z);
      this.body.add(arm);
    }
  }

  // ── 모터, 프로펠러, 추력 화살표, 번호 라벨 ──────────────────────
  #buildMotors() {
    const { armLength, propDiameter, motorRadius, motorHeight } = DRONE_SPEC;
    const motorMat = new THREE.MeshStandardMaterial({ color: COLORS.motor, roughness: 0.35, metalness: 0.6 });
    const motorGeo = new THREE.CylinderGeometry(motorRadius, motorRadius, motorHeight, 24);
    const bellGeo = new THREE.CylinderGeometry(motorRadius * 0.55, motorRadius * 0.9, 0.008, 24);

    MOTORS.forEach((m, i) => {
      const px = (m.x * armLength) / Math.SQRT2;
      const pz = (m.z * armLength) / Math.SQRT2;

      const mount = new THREE.Group();
      mount.position.set(px, 0, pz);
      this.body.add(mount);

      // 모터
      const motor = new THREE.Mesh(motorGeo, motorMat);
      motor.position.y = 0.012 + motorHeight / 2;
      const bell = new THREE.Mesh(bellGeo, motorMat);
      bell.position.y = 0.012 + motorHeight + 0.004;
      mount.add(motor, bell);

      // 프로펠러 (회전하는 부분)
      const prop = this.#makePropeller(propDiameter, m.dir > 0 ? COLORS.propCW : COLORS.propCCW, m.dir);
      prop.position.y = 0.012 + motorHeight + 0.01;
      prop.userData.dir = m.dir;
      mount.add(prop);
      this.props.push(prop);

      // 추력 화살표 (기체 기준 위쪽)
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, prop.position.y + 0.01, 0),
        0.15, 0xfacc15, 0.04, 0.025,
      );
      mount.add(arrow);
      this.thrustArrows.push(arrow);

      // 모터 번호 라벨
      const label = makeTextSprite(m.name);
      label.position.set(m.x * 0.05, 0.13, m.z * 0.05);
      mount.add(label);
      this.labels.push(label);
    });
  }

  #makePropeller(diameter, color, dir) {
    const prop = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1, transparent: true });
    prop.userData.bladeMat = bladeMat;

    // 날개 2개: 끝으로 갈수록 좁아지고, 회전 방향에 맞게 비틀림
    const bladeLen = diameter / 2;
    for (const side of [1, -1]) {
      const shape = new THREE.Shape();
      shape.moveTo(0, -0.008);
      shape.lineTo(bladeLen * 0.35, -0.013);
      shape.lineTo(bladeLen, -0.006);
      shape.lineTo(bladeLen, 0.004);
      shape.lineTo(bladeLen * 0.35, 0.011);
      shape.lineTo(0, 0.008);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.002, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const blade = new THREE.Mesh(geo, bladeMat);
      blade.rotation.y = side > 0 ? 0 : Math.PI;
      blade.rotation.x = 0.18 * dir * side; // 피치(비틀림)
      prop.add(blade);
    }

    // 허브
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.01, 16),
      new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.6, roughness: 0.3 }),
    );
    prop.add(hub);

    // 빠르게 돌 때 보이는 반투명 회전 원판 (잔상 효과)
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(diameter / 2, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    prop.add(disc);
    prop.userData.disc = disc;

    return prop;
  }

  // ── 배터리, LED, 착륙 다리 ─────────────────────────────────────
  #buildExtras() {
    const { bodySize } = DRONE_SPEC;

    const battery = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.028, 0.105),
      new THREE.MeshStandardMaterial({ color: COLORS.battery, roughness: 0.5 }),
    );
    battery.position.y = 0.053;
    this.body.add(battery);

    // 앞쪽 빨간 LED, 뒤쪽 초록 LED → 방향 구분
    const ledGeo = new THREE.SphereGeometry(0.009, 16, 16);
    const front = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({ color: COLORS.frontLed, emissive: COLORS.frontLed, emissiveIntensity: 2.5 }));
    front.position.set(0, 0.02, -bodySize * 0.65);
    const rear = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({ color: COLORS.rearLed, emissive: COLORS.rearLed, emissiveIntensity: 1.5 }));
    rear.position.set(0, 0.02, bodySize * 0.65);
    this.body.add(front, rear);

    // 앞쪽 카메라
    const cam = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.022, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.4 }),
    );
    cam.position.set(0, 0.018, -bodySize * 0.55);
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.007, 0.007, 0.006, 16),
      new THREE.MeshStandardMaterial({ color: 0x60a5fa, metalness: 0.9, roughness: 0.1 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.018, -bodySize * 0.55 - 0.012);
    this.body.add(cam, lens);

    // 착륙 다리 (스키드)
    const legMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.6 });
    const legGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8);
    const skidGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.16, 8);
    skidGeo.rotateX(Math.PI / 2);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(sx * 0.055, -0.035, sz * 0.05);
        leg.rotation.z = sx * 0.25;
        this.body.add(leg);
      }
      const skid = new THREE.Mesh(skidGeo, legMat);
      skid.position.set(sx * 0.064, -0.068, 0);
      this.body.add(skid);
    }
  }

  // ── 외부에서 쓰는 함수들 ────────────────────────────────────────

  /** 자세각 설정 (단위: 라디안). 나중에 PID 시뮬레이션 결과를 여기에 넣으면 됨 */
  setAttitude(roll, pitch, yaw) {
    this.body.rotation.z = -roll;  // Roll + → 오른쪽 아래로
    this.body.rotation.x = pitch;  // Pitch + → 기수 위로
    this.body.rotation.y = -yaw;   // Yaw + → 시계 방향
  }

  /** 모터별 추력 비율 (0~1) → 화살표 길이에 반영 */
  setThrusts(values) {
    this.thrusts = values.slice(0, 4);
    this.thrustArrows.forEach((a, i) => {
      const len = 0.05 + 0.25 * THREE.MathUtils.clamp(this.thrusts[i], 0, 1);
      a.setLength(len, 0.04, 0.025);
    });
  }

  setVisibility({ thrust, axes, labels }) {
    if (thrust !== undefined) this.thrustArrows.forEach((a) => (a.visible = thrust));
    if (axes !== undefined) this.axes.visible = axes;
    if (labels !== undefined) this.labels.forEach((l) => (l.visible = labels));
  }

  /** 매 프레임 호출: 프로펠러 회전 애니메이션. spin = 0~1 */
  update(dt, spin) {
    const maxRadPerSec = 60; // 화면용 회전 속도 (실제 RPM과 무관)
    this.props.forEach((p, i) => {
      const s = spin * (0.6 + 0.8 * this.thrusts[i]); // 추력이 클수록 빨리 돎
      // 위에서 볼 때 CW = Three.js Y축 기준 음의 회전
      p.rotation.y -= p.userData.dir * s * maxRadPerSec * dt;
      p.userData.disc.material.opacity = THREE.MathUtils.clamp((s - 0.3) * 0.35, 0, 0.22);
      // 빨리 돌수록 날개가 흐릿하게 보이도록
      p.userData.bladeMat.opacity = THREE.MathUtils.clamp(1.1 - s * 0.6, 0.45, 1);
    });
  }
}

// 글자를 그림으로 만들어 3D 공간에 띄우는 함수
function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15,23,32,0.85)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 112, 48, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.08, 0.04, 1);
  sprite.renderOrder = 10;
  return sprite;
}
