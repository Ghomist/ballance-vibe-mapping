// 从素材模型算木板、木桥这类路的吸附点，写到 src/box/asset-snap.ts。
// 吸附点都是模型上真实的顶点：取两头一小段里的顶点，投影到截面上取凸包，再去掉挨得太近、几乎共线的点。
// 边中点只有落在模型表面上才留（凹槽中间是空的，不能留）。模型或规则改了之后跑：node scripts/build-asset-snap.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('src/box/asset-info.ts', 'utf8');
const names = [...src.matchAll(/\{ name: '(\w+)'[^\n]*\}/g)].filter((m) => !m[0].includes('snapTop') && !/Crossing/.test(m[1])).map((m) => m[1]);

const BAND = 0.75; // 离端面多近的顶点算这一头
const MERGE = 0.45; // 比这更近的两个点只留一个
const FLAT = 0.12; // 离相邻两点连线比这更近的点算共线
const SURFACE = 0.03; // 边中点离模型表面的容差
const MAX_END = 6; // 一头最多留几个点：弧面上的点太多没用，留下撑起截面的那几个

/** 截面外轮廓算不到、但要留的点：木制斜板是底下横梁贴着立柱那一头的两个角（两端各一根横梁） */
const EXTRA = {
  Modul_13: [[0, 0, -0.787], [0, 1, -0.787], [0, 24.001, -0.787], [0, 25.001, -0.787]],
  // 特殊路块 15 里侧：两段接路的路沿（y 0～5、30～35）的两头，和中间缺口两边木板的上下角
  Modul_15: [[0, 0, 0], [0, 5, 0], [0, 5, -0.833], [0, 5, -2.022], [0, 29.982, 0], [0, 29.981, -0.832], [0, 29.981, -2.021], [0, 34.983, 0]],
};

/** 弧形的 U 型木板：上端朝上、下端斜着，两头截面按 Y 方向算不准，直接给端面的两条棱（[y, z]，左右各一个角、中间一个中点） */
const U_END = [[0, 0], [0.496, 0.065]];
const END_EDGES = {
  Level13_UWoodPath: [...U_END, [317.631, -67.422], [318.127, -67.357]],
  Level13_UWoodPath_Single: [...U_END, [63.526, -13.484], [64.022, -13.419]],
};

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hull(ps) {
  const s = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => { const h = []; for (const p of list) { while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], p) <= 1e-9) h.pop(); h.push(p); } h.pop(); return h; };
  return [...half(s), ...half([...s].reverse())];
}
function simplify(h) {
  let pts = [...h], changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (Math.abs(cross(a, b, p)) / len < FLAT || Math.hypot(p[0] - b[0], p[1] - b[1]) < MERGE) { pts.splice(i, 1); changed = true; break; }
    }
  }
  while (pts.length > MAX_END) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
      const d = Math.abs(cross(a, b, pts[i]));
      if (d < bd) { bd = d; best = i; }
    }
    pts.splice(best, 1);
  }
  return pts;
}
/** 点到三角形的距离（够用的近似：投影到平面后在三角形内才算） */
function onTri(p, t) {
  const [a, b, c] = t, e1 = b.map((v, i) => v - a[i]), e2 = c.map((v, i) => v - a[i]);
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const nl = Math.hypot(...n); if (nl < 1e-9) return false;
  const w = p.map((v, i) => v - a[i]), d = (w[0] * n[0] + w[1] * n[1] + w[2] * n[2]) / nl;
  if (Math.abs(d) > SURFACE) return false;
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2), d20 = dot(w, e1), d21 = dot(w, e2), den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-12) return false;
  const v = (d11 * d20 - d01 * d21) / den, u = (d00 * d21 - d01 * d20) / den;
  return v >= -0.01 && u >= -0.01 && v + u <= 1.01;
}

const r3 = (v) => +v.toFixed(3);
const out = {};
for (const name of names) {
  const asset = JSON.parse(readFileSync(`public/assets/${name}.json`, 'utf8'));
  const vs = [], tris = [];
  for (const part of asset.parts) {
    const p = part.pos;
    for (let i = 0; i < p.length; i += 3) vs.push([p[i], p[i + 1], p[i + 2]]);
    for (let i = 0; i + 8 < p.length; i += 9) tris.push([p.slice(i, i + 3), p.slice(i + 3, i + 6), p.slice(i + 6, i + 9)]);
  }
  const lo = [0, 1, 2].map((k) => Math.min(...vs.map((v) => v[k]))), hi = [0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])));
  const ext = [hi[0] - lo[0], hi[1] - lo[1]];
  const long = ext[0] >= ext[1] ? 0 : 1;
  const axes = ext[1 - long] >= ext[long] * 0.6 ? [0, 1] : [long];
  const verts = new Map(), mids = new Map();
  const key = (p) => p.map(r3).join();
  for (const ax of axes) for (const end of [lo[ax], hi[ax]]) {
    const u = 1 - ax;
    const band = vs.filter((v) => Math.abs(v[ax] - end) <= BAND);
    const proj = new Map();
    for (const v of band) { const q = [v[u], v[2]], k = q.map(r3).join(); const o = proj.get(k); if (!o || Math.abs(v[ax] - end) < Math.abs(o.v[ax] - end)) proj.set(k, { q, v }); }
    const ps = [...proj.values()].map((x) => Object.assign(x.q, { v: x.v }));
    if (ps.length < 3) continue;
    const h = simplify(hull(ps));
    for (const p of h) verts.set(key(p.v), p.v.map(r3));
    // 相邻两点的中点：只留落在模型表面上的，而且这条边要够长、近似水平（路面的边）
    for (let i = 0; i < h.length; i++) {
      const a = h[i].v, b = h[(i + 1) % h.length].v;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5 || Math.abs(a[2] - b[2]) > 0.3) continue;
      const m = a.map((x, k) => (x + b[k]) / 2);
      if (tris.some((t) => onTri(m, t))) mids.set(key(m), m.map(r3));
    }
  }
  for (const p of EXTRA[name] ?? []) verts.set(key(p), p);
  // 云层这种只有一张大面的，两头截面算不出来：取四个方向最远的顶点
  if (!verts.size && new Set(vs.map(key)).size <= 8) for (const v of vs) verts.set(key(v), v.map(r3));
  if (!verts.size) for (const [k, s] of [[0, 1], [0, -1], [1, 1], [1, -1]]) { const p = vs.reduce((a, b) => (b[k] * s > a[k] * s ? b : a)).map(r3); verts.set(key(p), p); }
  out[name] = END_EDGES[name]
    ? { verts: END_EDGES[name].flatMap(([y, z]) => [[lo[0], y, z], [hi[0], y, z]]), mids: END_EDGES[name].map(([y, z]) => [0, y, z]) }
    : { verts: [...verts.values()], mids: [...mids.values()] };
  console.log(name, 'verts', verts.size, 'mids', mids.size);
}
const body = Object.entries(out).map(([k, v]) => `  ${k}: { verts: ${JSON.stringify(v.verts)}, mids: ${JSON.stringify(v.mids)} },`).join('\n');
writeFileSync('src/box/asset-snap.ts', `// 由 scripts/build-asset-snap.mjs 生成，不要手改。木板、木桥这类路的吸附点（模型本地坐标，都是模型上真实的点）\nexport const ASSET_SNAP: Record<string, { verts: [number, number, number][]; mids: [number, number, number][] }> = {\n${body}\n};\n`);
