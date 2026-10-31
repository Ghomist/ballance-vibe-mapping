// 护栏：直道左右两侧 / 路块没接路的各边，每 5 个单位放一段资产库的 BarrierRail_1Edge。
//
// BarrierRail_1Edge 的本地坐标：沿 -X 方向长 5（x ∈ [-5, 0]），贴着 y = 0 这条边、在 y < 0 一侧（路面内侧），底部 z = 0。
// 因此摆放时本地 +X = 沿边前进方向 D，本地 +Y = 朝外方向 N（N 在 D 的左侧），原点放在每一段的末端。
import type { PrefabPart } from './checkpoint';
import { BLOCK, DX, DY, Dir, HALF, MNode, Model, Seg, endZ, nodePorts } from './types';

export const GUARD_ASSET = 'BarrierRail_1Edge';

const leftOf = (d: Dir): Dir => ((d + 1) % 4) as Dir;
const deg = (d: Dir) => d * 90;

/** 沿一条边放护栏：起点 (x0,y0,z0) 沿 D 走 len，高度线性变到 z1，朝外方向为 D 的左侧 */
function edgeParts(x0: number, y0: number, z0: number, D: Dir, len: number, z1: number): PrefabPart[] {
  const out: PrefabPart[] = [];
  if (len < 1) return out;
  const slope = (z1 - z0) / len;
  const pitch = -Math.atan(slope) * 180 / Math.PI;
  const ends: number[] = [];
  const n = Math.floor(len / BLOCK + 1e-6);
  for (let i = 1; i <= n; i++) ends.push(i * BLOCK);
  // 余下不足一段：补一段对齐末端（与前一段重叠）
  if (len - n * BLOCK > 0.5) ends.push(len);
  for (const e of ends) {
    out.push({
      name: GUARD_ASSET, type: 'asset', pos: [x0 + DX[D] * e, y0 + DY[D] * e, z0 + slope * e], rotZ: deg(D),
      pitch: Math.abs(pitch) > 1e-6 ? pitch : undefined,
    });
  }
  return out;
}

export function segGuardParts(m: Model, s: Seg): PrefabPart[] {
  const g = s.guard;
  if (!g || (!g.L && !g.R)) return [];
  const za = endZ(m, s, 'a'), zb = endZ(m, s, 'b');
  const L = leftOf(s.dir);
  const out: PrefabPart[] = [];
  if (g.L) {
    // 左侧：沿 dir 前进，朝外 = 左
    out.push(...edgeParts(s.x + DX[L] * HALF, s.y + DY[L] * HALF, za, s.dir, s.len, zb));
  }
  if (g.R) {
    // 右侧：从 b 端往回走（反方向的左侧就是原方向的右侧）
    const back = ((s.dir + 2) % 4) as Dir;
    const R = leftOf(back);
    const bx = s.x + DX[s.dir] * s.len, by = s.y + DY[s.dir] * s.len;
    out.push(...edgeParts(bx + DX[R] * HALF, by + DY[R] * HALF, zb, back, s.len, za));
  }
  return out;
}

export function blockGuardParts(m: Model, n: MNode): PrefabPart[] {
  if (n.kind !== 'block' || !n.guard) return [];
  const ports = nodePorts(m, n.id);
  const out: PrefabPart[] = [];
  for (const N of [0, 1, 2, 3] as Dir[]) {
    if (ports[N]) continue;
    const D = ((N + 3) % 4) as Dir; // N 是 D 的左侧
    const x0 = n.x + DX[N] * HALF - DX[D] * HALF, y0 = n.y + DY[N] * HALF - DY[D] * HALF;
    out.push(...edgeParts(x0, y0, n.z, D, BLOCK, n.z));
  }
  return out;
}

export function guardParts(m: Model, id: number): PrefabPart[] {
  if (m.segs[id]) return segGuardParts(m, m.segs[id]);
  if (m.nodes[id]) return blockGuardParts(m, m.nodes[id]);
  return [];
}
