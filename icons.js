/*
 * 앱 아이콘(PNG) 만들기 — 그림 파일 없이 코드로 직접 그림
 *   빌드할 때 vite.config.js가 이 파일을 불러서 icon-192.png, icon-512.png 를 만듦
 *   (StackBlitz에는 그림 파일을 붙여 넣기 어려워서 이렇게 함)
 *
 * 그림: 어두운 배경 + 위에서 본 X자 쿼드콥터 + 주황색 바람 줄기
 */
import { deflateSync } from 'node:zlib';

// ── PNG 파일 만들기 (픽셀 배열 → PNG) ──
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 필터 없음
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8비트 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 도형 (좌표는 0~1, 거리 함수로 그림) ──
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

function shapes() {
  const list = [];
  const c = 0.5, arm = 0.25; // 기체 중심, 팔 길이(대각선 방향 성분)
  const ends = [[c - arm, c - arm], [c + arm, c - arm], [c - arm, c + arm], [c + arm, c + arm]];
  // 바람 줄기 (뒤쪽에 깔림)
  const wave = (y0, amp) => (x, y) => {
    if (Math.abs(y - y0) > 0.06) return 1; // 멀리 있으면 계산 생략
    let d = 1;
    for (let i = 0; i < 40; i++) {
      const x1 = 0.08 + (i / 40) * 0.84, x2 = 0.08 + ((i + 1) / 40) * 0.84;
      const f = (xx) => y0 + amp * Math.sin((xx - 0.08) * 9);
      d = Math.min(d, segDist(x, y, x1, f(x1), x2, f(x2)));
    }
    return d;
  };
  list.push({ color: hex('#fb923c'), alpha: 0.55, dist: wave(0.2, 0.025), width: 0.012 });
  list.push({ color: hex('#fb923c'), alpha: 0.55, dist: wave(0.83, 0.025), width: 0.012 });
  // 팔 (X자)
  list.push({ color: hex('#94a3b8'), alpha: 1, dist: (x, y) => Math.min(segDist(x, y, ...ends[0], ...ends[3]), segDist(x, y, ...ends[1], ...ends[2])), width: 0.028 });
  // 프로펠러 원판 (반투명) + 테두리
  ends.forEach(([ex, ey], k) => {
    const col = k < 2 ? '#38bdf8' : '#4ade80';
    list.push({ color: hex(col), alpha: 0.22, dist: (x, y) => Math.max(Math.hypot(x - ex, y - ey) - 0.12, 0), width: 0 });
    list.push({ color: hex(col), alpha: 1, dist: (x, y) => Math.abs(Math.hypot(x - ex, y - ey) - 0.12), width: 0.012 });
    list.push({ color: hex('#e2e8f0'), alpha: 1, dist: (x, y) => Math.max(Math.hypot(x - ex, y - ey) - 0.03, 0), width: 0 });
  });
  // 몸체
  list.push({
    color: hex('#38bdf8'), alpha: 1, width: 0,
    dist: (x, y) => {
      const qx = Math.abs(x - c) - 0.07, qy = Math.abs(y - c) - 0.07;
      return Math.max(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.02, 0);
    },
  });
  return list;
}

/** size × size 아이콘. maskable = 안전 영역(가운데 80%) 안에 그림을 줄여 넣음 */
export function makeIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const list = shapes();
  const bgTop = hex('#14324a'), bgBot = hex('#0b1219');
  const scale = maskable ? 0.78 : 0.92;
  const SS = 2; // 2×2 샘플로 계단 현상 줄이기
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
        // 배경: maskable은 꽉 채움, 일반 아이콘은 둥근 사각형
        const rr = 0.2;
        const qx = Math.abs(u - 0.5) - (0.5 - rr), qy = Math.abs(v - 0.5) - (0.5 - rr);
        const inBg = maskable || Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= rr;
        if (!inBg) continue;
        let col = bgTop.map((t, i) => t + (bgBot[i] - t) * v);
        const x = 0.5 + (u - 0.5) / scale, y = 0.5 + (v - 0.5) / scale;
        for (const s of list) {
          if (s.dist(x, y) <= s.width / 2) col = col.map((t, i) => t + (s.color[i] - t) * s.alpha);
        }
        r += col[0]; g += col[1]; b += col[2]; a += 255;
      }
      const n = SS * SS, o = (py * size + px) * 4;
      if (a > 0) {
        const cov = a / 255; // 덮인 샘플 수
        rgba[o] = r / cov; rgba[o + 1] = g / cov; rgba[o + 2] = b / cov;
      }
      rgba[o + 3] = a / n;
    }
  }
  return encodePNG(size, rgba);
}
