// 花纹沿长度方向重复的木制件（波浪板、木桥这类）的「拉伸」：不是把模型拉长，而是把花纹一段一段接上去，
// 短了就在那个位置截断，截断处补一个端面。贴图、起伏的形状都和原来一样，不会被拉变形。
//
// 把模型看成一条无限长的花纹带（u 是沿长度的位置，模型原来占 0～base），要的是其中 off～off+len 这一段：
//   1. 从模型身子中间取整数个周期当一节（避开两头的端面；模型只有一个周期多一点时才从头取）；
//   2. 一节一节铺过去（每节沿长度挪 n·period，高度挪 n·dz），铺满要的那一段，两头各切一刀；
//   3. 切口上的边连成圈，补成端面（贴图沿用原来端面的贴法）；
//   4. 整体挪回去，让 off 那一头落在模型原点的位置（高度不动：从哪头拉，另一头在世界里都不动）。
// cont：模型每个周期的贴图是各贴各的、接不上（木制斜坡）。这时只取一个周期，后面每一节的贴图坐标顺着这一节接着往下排。
import type { TriMesh } from './clipmesh';

export interface TileSpec {
  /** 位置里哪个分量是长度方向、哪个是竖直方向（Blender 坐标竖直是 2；Virtools 坐标是 1，Blender 的 y 是 2） */
  ai: number;
  zi: number;
  /** 模型从原点往正方向（1）还是负方向（-1）长 */
  dir: 1 | -1;
  /** 模型原来的长度、花纹的周期、每个周期升高多少 */
  base: number;
  period: number;
  dz: number;
  /** 要的长度 */
  len: number;
  /** 从花纹带的哪里开始（默认 0，就是模型原来的那一头） */
  off?: number;
  /** 贴图坐标一节一节接着排（见上） */
  cont?: boolean;
}

type V = { p: number[]; t: number[]; n: number[] };
/** 一个凸多边形，带着它所在三角形里贴图坐标对位置的梯度（接着排贴图用） */
type Poly = { v: V[]; g: number[][] };
const EPS = 1e-3;
const lerp = (a: V, b: V, k: number): V => ({ p: a.p.map((v, i) => v + (b.p[i] - v) * k), t: a.t.map((v, i) => v + (b.t[i] - v) * k), n: a.n.map((v, i) => v + (b.n[i] - v) * k) });

/** 凸多边形留下 f ≤ 0 的那一半 */
function clip(poly: V[], f: (v: V) => number): V[] {
  const out: V[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = f(p), sq = f(q);
    if (sp <= EPS) out.push(p);
    if ((sp > EPS && sq < -EPS) || (sp < -EPS && sq > EPS)) out.push(lerp(p, q, sp / (sp - sq)));
  }
  return out.length >= 3 ? out : [];
}

/** 三角形里贴图坐标的两个分量各自对位置的梯度（在三角形平面内） */
function uvGrad(tri: V[]): number[][] {
  const e1 = tri[1].p.map((v, i) => v - tri[0].p[i]), e2 = tri[2].p.map((v, i) => v - tri[0].p[i]);
  const a = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], b = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], c = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
  const det = a * c - b * b;
  return [0, 1].map((k) => {
    if (Math.abs(det) < 1e-12) return [0, 0, 0];
    const d1 = tri[1].t[k] - tri[0].t[k], d2 = tri[2].t[k] - tri[0].t[k];
    const al = (c * d1 - b * d2) / det, be = (a * d2 - b * d1) / det;
    return [al * e1[0] + be * e2[0], al * e1[1] + be * e2[1], al * e1[2] + be * e2[2]];
  });
}

/** 简单多边形（二维）剪耳朵，返回三角形的顶点下标；pts 要是逆时针 */
function earClip(pts: [number, number][]): number[] {
  const idx = pts.map((_, i) => i), out: number[] = [];
  const cross = (a: number, b: number, c: number) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((k) => k !== a && k !== b && k !== c && cross(a, b, k) > 1e-12 && cross(b, c, k) > 1e-12 && cross(c, a, k) > 1e-12)) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break; // 退化的圈：剩下的不管
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * 按 TileSpec 取花纹带上的一段。parts：模型按材质分开的几部分（不带索引的三角形），返回同样顺序的几部分。
 */
export function tileMesh(parts: TriMesh[], t: TileSpec): TriMesh[] {
  const { ai, zi, dir, base, period, dz, len } = t;
  const u0 = t.off ?? 0, u1 = u0 + len;
  const oi = 3 - ai - zi;
  const u = (v: V) => dir * v.p[ai];
  // 一节从哪里取：尽量跳过第一个周期（那里有端面，底下可能是斜着收口的）
  const s = base >= 2 * period - 1e-6 ? period : 0;
  const n = t.cont ? 1 : Math.max(1, Math.floor((base - s + 1e-6) / period)), unit = n * period;
  /** 铺的时候每节挪多少：长度方向、竖直方向 */
  const stepA = dir * unit, stepZ = n * dz;
  const unitPolys: Poly[][] = parts.map(() => []);
  /** 原来远端端面上最大的一个三角形：补端面时照它的贴法 */
  let capRef: V[] | null = null, capScore = 0;
  /** 三角形的绕序和法线的关系（Blender 和 Virtools 坐标正好相反） */
  let hand = 0;
  const sweep = [0, 0, 0];
  sweep[ai] = dir * period; sweep[zi] = dz;
  const sl = Math.hypot(...sweep);
  parts.forEach((m, pi) => {
    for (let k = 0; k * 9 < m.pos.length; k++) {
      const tri: V[] = [0, 1, 2].map((j) => ({ p: m.pos.slice(k * 9 + j * 3, k * 9 + j * 3 + 3), t: m.uv.slice(k * 6 + j * 2, k * 6 + j * 2 + 2), n: m.nrm ? m.nrm.slice(k * 9 + j * 3, k * 9 + j * 3 + 3) : [0, 0, 0] }));
      const e1 = tri[1].p.map((v, i) => v - tri[0].p[i]), e2 = tri[2].p.map((v, i) => v - tri[0].p[i]);
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const area = Math.hypot(...cr);
      if (area < 1e-10) continue;
      if (!hand) { const d = cr[0] * tri[0].n[0] + cr[1] * tri[0].n[1] + cr[2] * tri[0].n[2]; if (Math.abs(d) > 1e-9) hand = Math.sign(d); }
      // 远端的端面：靠着远端、面朝长度方向
      const us = tri.map(u);
      if (Math.min(...us) > base - 0.1 * period - 1) { const sc = area * Math.abs(cr[0] * sweep[0] + cr[1] * sweep[1] + cr[2] * sweep[2]) / (area * sl); if (sc > capScore && sc > 0.5 * area) { capScore = sc; capRef = tri; } }
      // 这一节：身子在 s～s+unit 之间的部分，挪到从 0 开始
      const c = clip(clip(tri, (v) => s - u(v)), (v) => u(v) - (s + unit));
      if (!c.length) continue;
      const moved = s ? c.map((v) => { const p = [...v.p]; p[ai] -= dir * s; p[zi] -= (dz * s) / period; return { ...v, p }; }) : c;
      unitPolys[pi].push({ v: moved, g: t.cont ? uvGrad(tri) : [] });
    }
  });
  const out: V[][][] = parts.map(() => []);
  /** 两个切口上的边（端面的轮廓）：0 是开头那一刀，1 是末尾那一刀 */
  const segs: { a: V; b: V; part: number }[][] = [[], []];
  const k0 = Math.floor(u0 / unit + 1e-9), k1 = Math.max(k0, Math.ceil(u1 / unit - 1e-9) - 1);
  for (let k = k0; k <= k1; k++) {
    unitPolys.forEach((polys, pi) => {
      for (const poly of polys) {
        let c = poly.v.map((v) => {
          const p = [...v.p];
          p[ai] += k * stepA; p[zi] += k * stepZ;
          // 贴图顺着这一节接着排：挪了多远，贴图坐标就按梯度走多远
          const tt = t.cont ? v.t.map((x, j) => x + k * (poly.g[j][ai] * stepA + poly.g[j][zi] * stepZ)) : v.t;
          return { p, t: tt, n: v.n };
        });
        if (k === k0) c = clip(c, (v) => u0 - u(v));
        if (k === k1 && c.length) c = clip(c, (v) => u(v) - u1);
        if (!c.length) continue;
        out[pi].push(c);
        for (let i = 0; i < c.length; i++) {
          const a = c[i], b = c[(i + 1) % c.length];
          if (k === k0 && Math.abs(u(a) - u0) < 2 * EPS && Math.abs(u(b) - u0) < 2 * EPS) segs[0].push({ a, b, part: pi });
          if (k === k1 && Math.abs(u(a) - u1) < 2 * EPS && Math.abs(u(b) - u1) < 2 * EPS) segs[1].push({ a, b, part: pi });
        }
      }
    });
  }
  // 端面上 (横向, 高度) → 贴图坐标：照原来的端面解一个仿射变换；没有端面可照就按 0.2 的密度平铺
  let uvAt = (o: number, z: number): number[] => [o * 0.2, z * 0.2];
  if (capRef) {
    const [r0, r1, r2] = capRef as V[];
    const a = r1.p[oi] - r0.p[oi], b = r1.p[zi] - r0.p[zi], c = r2.p[oi] - r0.p[oi], d = r2.p[zi] - r0.p[zi], det = a * d - b * c;
    if (Math.abs(det) > 1e-9) {
      const g = [0, 1].map((j) => { const d1 = r1.t[j] - r0.t[j], d2 = r2.t[j] - r0.t[j]; return [(d1 * d - d2 * b) / det, (a * d2 - c * d1) / det]; });
      uvAt = (o, z) => [0, 1].map((j) => r0.t[j] + g[j][0] * (o - r0.p[oi]) + g[j][1] * (z - r0.p[zi]));
    }
  }
  // 端面：切口上的边首尾相接连成圈，每一圈剪耳朵补上。开头那一刀的端面朝后，末尾的朝前
  const key = (v: V) => `${Math.round(v.p[oi] * 500)},${Math.round(v.p[zi] * 500)}`;
  // (横向, 高度) 逆时针的三角形，几何法线在长度方向上的分量是正是负，取决于三个分量的排列
  const e1 = [0, 0, 0], e2 = [0, 0, 0];
  e1[oi] = 1; e2[zi] = 1;
  const cn = e1[(ai + 1) % 3] * e2[(ai + 2) % 3] - e1[(ai + 2) % 3] * e2[(ai + 1) % 3];
  segs.forEach((list, end) => {
    const at = end ? u1 : u0, face = (end ? 1 : -1) * dir;
    const seen = new Set<string>(), next = new Map<string, { to: V; part: number; used: boolean }[]>(), startPos = new Map<string, number[]>();
    for (const sg of list) {
      const ka = key(sg.a), kb = key(sg.b);
      if (ka === kb) continue;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(id)) continue;
      seen.add(id);
      startPos.set(ka, sg.a.p); startPos.set(kb, sg.b.p);
      next.set(ka, [...(next.get(ka) ?? []), { to: sg.b, part: sg.part, used: false }]);
      next.set(kb, [...(next.get(kb) ?? []), { to: sg.a, part: sg.part, used: false }]);
    }
    const capN = [0, 0, 0];
    capN[ai] = face;
    const flip = cn * face * (hand || 1) < 0;
    // 先走开口的链（从只连着一条边的点出发），再走闭合的圈。这些模型多半没有底面，切口是一条开口的折线（侧面 → 顶面 → 侧面）：
    // 把两头直接连上当成一圈，端面照样补
    const order = [...next].sort((a, b) => a[1].length - b[1].length);
    for (const [start, edges] of order) {
      for (const first of edges) {
        if (first.used) continue;
        const open = edges.length === 1;
        const ring: V[] = open ? [{ ...first.to, p: startPos.get(start)! }] : [];
        let cur = start, e: typeof first | undefined = first, guard = 0;
        while (e && !e.used && guard++ < 100000) {
          e.used = true;
          const from = cur;
          const back = next.get(key(e.to))?.find((x) => !x.used && key(x.to) === from);
          if (back) back.used = true;
          ring.push(e.to);
          cur = key(e.to);
          e = next.get(cur)?.find((x) => !x.used);
        }
        if (ring.length < 3 || (!open && cur !== start)) continue; // 圈没闭合（切在缝里）：不补
        let pts = ring.map((v): [number, number] => [v.p[oi], v.p[zi]]);
        let area = 0;
        for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
        if (Math.abs(area) < 1e-8) continue;
        if (area < 0) pts = pts.reverse();
        const tri = earClip(pts);
        for (let i = 0; i < tri.length; i += 3) {
          const ids = flip ? [tri[i], tri[i + 2], tri[i + 1]] : [tri[i], tri[i + 1], tri[i + 2]];
          out[first.part].push(ids.map((j) => { const p = [0, 0, 0]; p[ai] = dir * at; p[oi] = pts[j][0]; p[zi] = pts[j][1]; return { p, t: uvAt(pts[j][0], pts[j][1]), n: capN }; }));
        }
      }
    }
  });
  // 开头那一刀落在模型原点的位置
  const shift = dir * u0;
  return out.map((polys, pi) => {
    const m: TriMesh = { pos: [], uv: [], ...(parts[pi].nrm ? { nrm: [] } : {}) };
    for (const poly of polys) for (let i = 1; i + 1 < poly.length; i++) for (const v of [poly[0], poly[i], poly[i + 1]]) {
      const p = [...v.p];
      p[ai] -= shift;
      m.pos.push(...p); m.uv.push(...v.t); m.nrm?.push(...v.n);
    }
    return m;
  });
}
