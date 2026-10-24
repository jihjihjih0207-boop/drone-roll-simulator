import * as THREE from 'three';

/*
 * 바람 흐름 시각화 (화면용 연출 — 실제 계산은 physics.js의 풍속 숫자로 함)
 *
 *   - 맵 전체에 바람 입자를 뿌리고, 입자마다 지나온 자리를 꼬리로 남겨 휘어지는 흐름을 보여 줌
 *   - 흐름 속도 = 기본 바람(풍향 방향) + 드론을 피해 돌아가는 흐름 + 오르내리는 기류 + 난류 소용돌이
 *       · 풍향: 0° = 왼쪽→오른쪽 옆바람, 90° = 정면→뒤쪽 맞바람
 *       · 드론 주변: 원기둥 주위 흐름(퍼텐셜 흐름) 공식으로 위아래로 갈라져 돌아감
 *       · 난류: 바람 방향이 계속 조금씩 흔들리고, 크고 느린 소용돌이가 생김
 *   - 공간 밖으로 나간 입자는 반대편에서 다시 들어옴 → 맵 전체에 고르게 바람이 붊
 */
export class WindField {
  constructor({
    count = 1400,                                    // 바람 입자 수
    trail = 10,                                      // 꼬리 길이 (점 개수)
    box = { x: 10, yMin: 0.08, yMax: 5, z: 10 },    // 바람이 보이는 공간 = 맵 전체
    obstacles = [{ x: 0, y: 1.0, z: 0, r: 0.32 }],  // 드론 위치와 피해 가는 반지름 (여러 대 가능)
  } = {}) {
    Object.assign(this, { count, trail, box, obstacles });
    this.speed = 0;
    this.turbulence = 0;
    this.direction = 0; // 풍향 (°)
    this.time = 0;

    this.pos = new Float32Array(count * 3);            // 입자 현재 위치
    this.hist = new Float32Array(count * trail * 3);   // 꼬리 기록
    this.seed = new Float32Array(count);               // 입자마다 다른 출렁임

    const segs = count * (trail - 1);
    this.positions = new Float32Array(segs * 6);
    this.colors = new Float32Array(segs * 6);

    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * box.x;
      const y = box.yMin + Math.random() ** 1.6 * (box.yMax - box.yMin); // 낮은 곳에 조금 더 많이
      const z = (Math.random() * 2 - 1) * box.z;
      this.#place(i, x, y, z);
      this.seed[i] = Math.random() * 100;
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
  #velocity(x, y, z, s, dirX, dirZ) {
    const U = this.speed;
    const a = Math.abs(U);
    const t = this.time;

    // 바람 방향 기준 좌표: 바람 방향 거리(along), 높이(up), 옆 거리(side)
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

    // ② 오르내리는 기류와 옆으로 퍼지는 출렁임 (완전한 직선이 되지 않도록)
    uUp += a * (0.2 * Math.sin(x * 0.35 + z * 0.27 + t * 0.6 + s) + 0.1 * Math.sin(x * 1.3 - t * 1.1 + s * 2));
    let uSide = a * 0.15 * Math.sin(along * 0.5 + y * 0.8 - t * 0.5 + s * 1.3);

    // ③ 난류 소용돌이: 크고 느린 회전 흐름
    if (this.turbulence > 0) {
      const T = this.turbulence * (1.2 + a * 0.35);
      uAlong += T * 0.4 * Math.sin(y * 1.2 + t * 0.9 + s) * Math.cos(side * 0.8);
      uUp += T * 0.8 * Math.sin(along * 0.9 - t * 1.1 + s * 0.3) * Math.cos(side * 0.7 + t * 0.4);
      uSide += T * 0.7 * Math.cos(along * 0.7 + y * 1.1 + t * 0.8);
    }

    // 바람 방향 좌표 → 화면 좌표
    return [uAlong * dirX - uSide * dirZ, uUp, uAlong * dirZ + uSide * dirX];
  }

  update(dt) {
    const { count, trail, box } = this;
    const a = Math.abs(this.speed);
    this.lines.visible = a > 0.05;
    if (!this.lines.visible) return;

    if (dt > 0) {
      this.time += dt;
      // 난류일 때는 바람 방향이 천천히 ±25° 정도 흔들림
      const wander = this.turbulence * 25 * (Math.sin(this.time * 0.37) + 0.5 * Math.sin(this.time * 0.91 + 1));
      const phi = ((this.direction + wander) * Math.PI) / 180;
      const dirX = Math.cos(phi), dirZ = Math.sin(phi);
      const scale = 0.4; // 화면에서 실제 풍속의 0.4배로 흐르게 함

      for (let i = 0; i < count; i++) {
        const o = i * 3;
        let x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2];
        const [vx, vy, vz] = this.#velocity(x, y, z, this.seed[i], dirX, dirZ);
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