import * as THREE from 'three';

/*
 * 쿼드콥터(X자형) 3D 모델
 *   +Y : 위쪽 / -Z : 기체 앞쪽(빨간 LED) / +X : 기체 오른쪽
 *
 *        앞(-Z)
 *    m1 ↻      m2 ↺
 *         [몸체]
 *    m4 ↺      m3 ↻
 *        뒤(+Z)
 *   m1, m3 : 시계 방향(CW) / m2, m4 : 반시계 방향(CCW)
 *
 * 자세각 부호: Roll+ 오른쪽 내려감 / Pitch+ 기수 올라감 / Yaw+ 시계 방향
 */

export const DRONE_SPEC = {
  armLength: 0.225,      // 기체 중심 ~ 모터 중심 거리 L (m)
  bodySize: 0.12,
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

// 모터 위치(x, z 부호)와 회전 방향(+1 = CW, -1 = CCW)
const MOTORS = [
  { name: 'm1', x: -1, z: -1, dir: +1 }, // 앞-왼쪽
  { name: 'm2', x: +1, z: -1, dir: -1 }, // 앞-오른쪽
  { name: 'm3', x: +1, z: +1, dir: +1 }, // 뒤-오른쪽
  { name: 'm4', x: -1, z: +1, dir: -1 }, // 뒤-왼쪽
];

export class Drone {
  constructor() {
    this.group = new THREE.Group();     // 위치(이동)용
    this.body = new THREE.Group();      // 자세(회전)용
    this.body.rotation.order = 'YXZ';   // Yaw → Pitch → Roll 순서
    this.group.add(this.body);

    this.props = [];
    this.thrustArrows = [];
    this.labels = [];
    this.thrusts = [0.5, 0.5, 0.5, 0.5];

    this.#buildFrame();
    this.#buildMotors();
    this.#buildExtras();

    this.axes = new THREE.AxesHelper(0.35);
    this.axes.position.y = 0.06;
    this.body.add(this.axes);

    this.body.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    this.props.forEach((p) => { p.userData.disc.castShadow = false; p.userData.disc.receiveShadow = false; });
  }

  #buildFrame() {
    const { armLength, bodySize } = DRONE_SPEC;
    const carbon = new THREE.MeshStandardMaterial({ color: COLORS.carbon, roughness: 0.55, metalness: 0.3 });
    const carbonLight = new THREE.MeshStandardMaterial({ color: COLORS.carbonLight, roughness: 0.5, metalness: 0.3 });

    const plateGeo = new THREE.BoxGeometry(bodySize, 0.006, bodySize * 1.25);
    const bottom = new THREE.Mesh(plateGeo, carbon);
    const top = new THREE.Mesh(plateGeo, carbon);
    top.position.y = 0.035;
    this.body.add(bottom, top);

    const standoffGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.035, 8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const s = new THREE.Mesh(standoffGeo, carbonLight);
      s.position.set(sx * bodySize * 0.4, 0.0175, sz * bodySize * 0.5);
      this.body.add(s);
    }

    const fc = new THREE.Mesh(
      new THREE.BoxGeometry(0.036, 0.008, 0.036),
      new THREE.MeshStandardMaterial({ color: 0x065f46, roughness: 0.6 }),
    );
    fc.position.y = 0.018;
    this.body.add(fc);

    const armGeo = new THREE.BoxGeometry(0.022, 0.012, armLength);
    for (const m of MOTORS) {
      const arm = new THREE.Mesh(armGeo, carbon);
      arm.position.set((m.x * armLength * 0.5) / Math.SQRT2, 0.003, (m.z * armLength * 0.5) / Math.SQRT2);
      arm.rotation.y = Math.atan2(m.x, m.z);
      this.body.add(arm);
    }
  }

  #buildMotors() {
    const { armLength, propDiameter, motorRadius, motorHeight } = DRONE_SPEC;
    const motorMat = new THREE.MeshStandardMaterial({ color: COLORS.motor, roughness: 0.35, metalness: 0.6 });
    const motorGeo = new THREE.CylinderGeometry(motorRadius, motorRadius, motorHeight, 24);
    const bellGeo = new THREE.CylinderGeometry(motorRadius * 0.55, motorRadius * 0.9, 0.008, 24);

    MOTORS.forEach((m) => {
      const mount = new THREE.Group();
      mount.position.set((m.x * armLength) / Math.SQRT2, 0, (m.z * armLength) / Math.SQRT2);
      this.body.add(mount);

      const motor = new THREE.Mesh(motorGeo, motorMat);
      motor.position.y = 0.012 + motorHeight / 2;
      const bell = new THREE.Mesh(bellGeo, motorMat);
      bell.position.y = 0.012 + motorHeight + 0.004;
      mount.add(motor, bell);

      const prop = this.#makePropeller(propDiameter, m.dir > 0 ? COLORS.propCW : COLORS.propCCW, m.dir);
      prop.position.y = 0.012 + motorHeight + 0.01;
      prop.userData.dir = m.dir;
      mount.add(prop);
      this.props.push(prop);

      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, prop.position.y + 0.01, 0),
        0.15, 0xfacc15, 0.04, 0.025,
      );
      mount.add(arrow);
      this.thrustArrows.push(arrow);

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
      blade.rotation.x = 0.18 * dir * side;
      prop.add(blade);
    }

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.01, 16),
      new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.6, roughness: 0.3 }),
    );
    prop.add(hub);

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

  #buildExtras() {
    const { bodySize } = DRONE_SPEC;

    const battery = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.028, 0.105),
      new THREE.MeshStandardMaterial({ color: COLORS.battery, roughness: 0.5 }),
    );
    battery.position.y = 0.053;
    this.body.add(battery);

    const ledGeo = new THREE.SphereGeometry(0.009, 16, 16);
    const front = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({ color: COLORS.frontLed, emissive: COLORS.frontLed, emissiveIntensity: 2.5 }));
    front.position.set(0, 0.02, -bodySize * 0.65);
    const rear = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({ color: COLORS.rearLed, emissive: COLORS.rearLed, emissiveIntensity: 1.5 }));
    rear.position.set(0, 0.02, bodySize * 0.65);
    this.body.add(front, rear);

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

  /** 자세각 설정 (라디안). 나중에 PID 계산 결과를 여기에 넣음 */
  setAttitude(roll, pitch, yaw) {
    this.body.rotation.z = -roll;
    this.body.rotation.x = pitch;
    this.body.rotation.y = -yaw;
  }

  /** 모터별 추력 비율 (0~1) → 화살표 길이 */
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

  /** 매 프레임: 프로펠러 회전. spin = 0~1 */
  update(dt, spin) {
    const maxRadPerSec = 60;
    this.props.forEach((p, i) => {
      const s = spin * (0.6 + 0.8 * this.thrusts[i]);
      p.rotation.y -= p.userData.dir * s * maxRadPerSec * dt;
      p.userData.disc.material.opacity = THREE.MathUtils.clamp((s - 0.3) * 0.35, 0, 0.22);
      p.userData.bladeMat.opacity = THREE.MathUtils.clamp(1.1 - s * 0.6, 0.45, 1);
    });
  }
}

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