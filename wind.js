import * as THREE from 'three';

/*
 * 바람 흐름 시각화 (화면용 연출 — 실제 계산은 physics.js의 풍속 숫자로 함)
 *
 *   흐름 속도 = 기본 바람(풍향 방향)
 *             + 드론을 피해 돌아가는 흐름 (원기둥 주위 흐름 공식)
 *             + 부드러운 기복 (바람이 천천히 출렁임)
 *             + 난류 소용돌이 (값 잡음으로 만든 덩어리 바람)
 *             + 건물 모서리 쪽의 하강 기류 (도시 연구에서 본 '위에서 내려오는 바람')
 *
 *   - 값 잡음(value noise): 격자점마다 난수를 주고 사이를 부드러운 곡선으로 이음
 *     → 사인파를 겹친 것과 달리 줄무늬가 규칙적으로 보이지 않고, 튀는 곳도 없음
 *   - 풍속이 갑자기 바뀌어도 화면의 흐름 속도는 천천히 따라감 (돌풍이 깜빡이지 않게)
 *   - 공간 밖으로 나간 입자는 반대편에서 다시 들어옴 → 맵 전체에 고르게 바람이 붊
 */

// ── 값 잡음 ──────────────────────────────────────────────────────────
// 정수 격자점 (x, y, z)에 -1 ~ 1 사이의 고정된 난수를 줌 (같은 자리는 항상 같은 값)
const hash = (x, y, z, seed) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
};
// 부드러운 보간 곡선 (기울기가 격자점에서 0이라 이음새가 보이지 않음)
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** 위치 (x, y, z)의 부드러운 잡음 값 (대략 -1 ~ 1) */
function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz, seed);
  const x0 = lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v);
  const x1 = lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v);
  return lerp(x0, x1, w);
}

export class WindField {
  constructor({
    count = 1400,                                    // 바람 입자 수
    trail = 12,                                      // 꼬리 길이 (점 개수)
    box = { x: 10, yMin: 0.08, yMax: 5, z: 10 },    // 바람이 보이는 공간 = 맵 전체
    obstacles = [{ x: 0, y: 1.0, z: 0, r: 0.32 }],  // 드론 위치와 피해 가는 반지름 (여러 대 가능)
  } = {}) {
    Object.assign(this, { count, trail, box, obstacles });
    this.speed = 0;        // 목표 풍속 (physics.js가 계산한 지금 풍속)
    this.shown = 0;        // 화면에 보이는 풍속 (목표를 천천히 따라감)
    this.turbulence = 0;
    this.direction = 0;    // 풍향 (°)
    this.time = 0;

    this.pos = new Float32Array(count * 3);            // 입자 현재 위치
    this.hist = new Float32Array(count * trail * 3);   // 꼬리 기록

    const segs = count * (trail - 1);
    this.positions = new Float32Array(segs * 6);
    this.colors = new Float32Array(segs * 6);

    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * box.x;
      const y = box.yMin + Math.random() ** 1.6 * (box.yMax - box.yMin); // 낮은 곳에 조금 더 많이
      const z = (Math.random() * 2 - 1) * box.z;
      this.#place(i, x, y, z);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // 겹칠수록 밝게, 꼬리 끝은 어둡게 = 흐려 보임
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
  }

  /** 입자를 (x, y, z)에 놓고 꼬리를 지움 */
  #place(i, x, y, z) {
    this.pos.set([x, y, z], i * 3);
    for (let k = 0; k < this.trail; k++) this.hist.set([x, y, z], (i * this.trail + k) * 3);
  }

  /** 풍속(m/s), 난류 정도(0~1), 풍향(°)을 정함 */
  set(speed, turbulence = 0, direction = 0) {
    this.speed = speed;
    this.turbulence = turbulence;
    this.direction = direction;
  }

  /** 드론 위치 목록을 바꿈 (비교 모드에서 드론 두 대) */
  setObstacles(list) { this.obstacles = list; }

  /** (x, y, z) 위치의 흐름 속도 (화면 단위) */
  #velocity(x, y, z, dirX, dirZ) {
    const U = this.shown;
    const a = Math.abs(U);
    const t = this.time * 0.4; // 소용돌이가 천천히 흘러가도록

    // 바람 방향 기준 좌표: 바람 방향 거리(along), 높이(y), 옆 거리(side)
    const along = x * dirX + z * dirZ;
    const side = -x * dirZ + z * dirX;

    // ① 기본 바람 + 드론을 피해 위아래로 돌아가는 흐름 (원기둥 주위 흐름, 드론마다 더함)
    let uAlong = U, uUp = 0;
    for (const ob of this.obstacles) {
      const rx = x - ob.x, ry = y - ob.y, rz = z - ob.z;
      const al = rx * dirX + rz * dirZ;
      const sd = -rx * dirZ + rz * dirX;
      const r2 = al * al + ry * ry;
      const R2 = ob.r * ob.r;
      if (r2 > R2 * 0.6 && r2 < 9) {
        const k = (R2 / (r2 * r2)) * Math.exp(-((sd / 0.5) ** 2));
        uAlong -= U * k * (al * al - ry * ry);
        uUp -= U * k * 2 * al * ry;
      }
    }

    // ② 부드러운 기복: 바람이 완전히 일직선으로 흐르지 않도록 천천히 출렁임
    const drift = a * 0.14;
    let uSide = drift * noise3(along * 0.5, y * 0.8, side * 0.5 + t * 0.5, 11);
    uUp += drift * 0.8 * noise3(along * 0.5 + 4.1, y * 0.8, side * 0.5, 12);

    // ③ 난류 소용돌이: 세 방향으로 각각 다른 잡음을 써서 덩어리가 제각각 움직이게 함
    if (this.turbulence > 0) {
      const T = this.turbulence * (1.0 + a * 0.3);
      const p = along * 0.55, q = side * 0.55;
      uAlong += T * 0.5 * noise3(p, y * 0.9, q + t, 21);
      uUp += T * 0.9 * noise3(p + 3.3, y * 0.9, q, 22);
      uSide += T * 0.7 * noise3(p, y * 0.9 + 5.2, q, 23);

      // ④ 하강 기류: 바람이 강할수록 건물 모서리에서 위에서 아래로 내려오는 덩어리가 생김
      const sink = noise3(along * 0.35, 0.5, side * 0.35 - t * 0.5, 31);
      uUp -= T * 1.2 * Math.max(sink, 0);
    }

    // 바람 방향 좌표 → 화면 좌표
    return [uAlong * dirX - uSide * dirZ, uUp, uAlong * dirZ + uSide * dirX];
  }

  update(dt) {
    const { count, trail, box } = this;
    this.lines.visible = Math.abs(this.speed) > 0.05 || Math.abs(this.shown) > 0.05;
    if (!this.lines.visible) return;

    if (dt > 0) {
      this.time += dt;
      // 화면 속도는 목표 풍속을 천천히 따라감 (약 0.4초 시간 상수)
      this.shown += (this.speed - this.shown) * Math.min(dt * 2.5, 1);
      // 난류일 때는 바람 방향이 천천히 ±30° 정도 흔들림
      const wander = this.turbulence * 30 * noise3(this.time * 0.3, 0.5, 0.5, 41);
      const phi = ((this.direction + wander) * Math.PI) / 180;
      const dirX = Math.cos(phi), dirZ = Math.sin(phi);
      const scale = 0.4; // 화면에서 실제 풍속의 0.4배로 흐르게 함

      for (let i = 0; i < count; i++) {
        const o = i * 3;
        let x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2];
        const [vx, vy, vz] = this.#velocity(x, y, z, dirX, dirZ);
        x += vx * scale * dt;
        y += vy * scale * dt;
        z += vz * scale * dt;

        // 공간 밖으로 나가면 반대편에서 다시 들어옴 (꼬리는 지움)
        let wrapped = false;
        if (x > box.x) { x -= 2 * box.x; wrapped = true; } else if (x < -box.x) { x += 2 * box.x; wrapped = true; }
        if (z > box.z) { z -= 2 * box.z; wrapped = true; } else if (z < -box.z) { z += 2 * box.z; wrapped = true; }
        if (y > box.yMax) { y = box.yMin + Math.random() * 0.5; wrapped = true; } else if (y < box.yMin) { y = box.yMax - Math.random() * 0.5; wrapped = true; }
        if (wrapped) { this.#place(i, x, y, z); continue; }

        this.pos.set([x, y, z], o);
        const h = i * trail * 3;
        this.hist.copyWithin(h + 3, h, h + (trail - 1) * 3); // 꼬리 한 칸씩 밀기
        this.hist.set([x, y, z], h);
      }
    }

    // 꼬리를 선분으로 그리기: 앞쪽은 밝게, 뒤쪽은 어둡게
    const a = Math.abs(this.shown);
    const strength = Math.min(a / 12, 1);
    const base = new THREE.Color().setHSL(0.56, 0.85 - strength * 0.45, 0.6 + strength * 0.2);
    let p = 0;
    for (let i = 0; i < count; i++) {
      const h = i * trail * 3;
      for (let k = 0; k < trail - 1; k++) {
        const f0 = 1 - k / (trail - 1);
        const f1 = 1 - (k + 1) / (trail - 1);
        for (let c = 0; c < 3; c++) {
          this.positions[p + c] = this.hist[h + k * 3 + c];
          this.positions[p + 3 + c] = this.hist[h + (k + 1) * 3 + c];
        }
        this.colors[p] = base.r * f0; this.colors[p + 1] = base.g * f0; this.colors[p + 2] = base.b * f0;
        this.colors[p + 3] = base.r * f1; this.colors[p + 4] = base.g * f1; this.colors[p + 5] = base.b * f1;
        p += 6;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.material.opacity = 0.3 + strength * 0.55;
  }
}
