// 钢轨跟着路面走：钢轨端头接在路面端头（直道自由端、路块 / 底座 / 盘点的空路口）上时，
// 路面伸缩或移动后，钢轨的这一头跟过去——沿钢轨方向的移动就伸缩钢轨，其余情况整条平移。
import { extendStart, railEnd, RailState } from './rail';
import { DX, DY, Dir, Model, endOutDir, endPos, isFree, nodeHalf, nodePortDirs, nodePorts } from './types';

type Attach = { seg: number; key: 'a' | 'b' } | { node: number; dir: Dir };

const sameAng = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180) < 0.5;

/** 端点 P（heading 为从路面指向钢轨里的方向）接在哪个路面端头上 */
function findAttach(m: Model, P: RailState): Attach | null {
  for (const s of Object.values(m.segs)) {
    for (const key of ['a', 'b'] as const) {
      if (!isFree(s[key])) continue;
      const [x, y] = endPos(s, key);
      if (Math.hypot(x - P.x, y - P.y) < 0.05 && sameAng(endOutDir(s, key) * 90, P.heading)) return { seg: s.id, key };
    }
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'block' && n.kind !== 'base' && n.kind !== 'checkpoint') continue;
    const ports = nodePorts(m, n.id);
    for (const d of nodePortDirs(n)) {
      if (ports[d] || !sameAng(d * 90, P.heading)) continue;
      const h = nodeHalf(n, d);
      if (Math.hypot(n.x + DX[d] * h - P.x, n.y + DY[d] * h - P.y) < 0.05) return { node: n.id, dir: d };
    }
  }
  return null;
}

function attachPos(m: Model, a: Attach): [number, number] | null {
  if ('seg' in a) {
    const s = m.segs[a.seg];
    return s && isFree(s[a.key]) ? endPos(s, a.key) : null;
  }
  const n = m.nodes[a.node];
  if (!n) return null;
  const h = nodeHalf(n, a.dir);
  return [n.x + DX[a.dir] * h, n.y + DY[a.dir] * h];
}

/** before → after 之间路面动过：接在上面的钢轨端头跟过去（可重复调用，结果不变） */
export function followRails(before: Model, after: Model) {
  for (const r of Object.values(after.rails)) {
    const r0 = before.rails[r.id];
    if (!r0 || !r0.pieces.length || !r.pieces.length) continue;
    for (const end of ['a', 'b'] as const) {
      const E0 = railEnd(r0);
      const P0: RailState = end === 'a' ? { x: r0.x, y: r0.y, z: r0.z, heading: r0.heading } : { ...E0, heading: E0.heading + 180 };
      const att = findAttach(before, P0);
      if (!att) continue;
      const was = attachPos(before, att), now = attachPos(after, att);
      if (!was || !now || Math.hypot(now[0] - was[0], now[1] - was[1]) < 1e-6) continue; // 路面没动
      const E = railEnd(r);
      const cur = end === 'a' ? [r.x, r.y] : [E.x, E.y];
      const dx = now[0] - cur[0], dy = now[1] - cur[1];
      if (Math.hypot(dx, dy) < 1e-6) continue;
      const h = (P0.heading * Math.PI) / 180;
      const along = dx * Math.cos(h) + dy * Math.sin(h), lat = -dx * Math.sin(h) + dy * Math.cos(h);
      if (Math.abs(lat) < 1e-4) {
        // 沿钢轨方向：伸缩（along > 0 表示路面伸进了钢轨，钢轨变短）
        if (end === 'a') {
          const first = r.pieces[0];
          if (along < 0 || (first.angle === 0 && first.len - along >= 0.5)) { extendStart(r, -along); continue; }
        } else {
          const last = r.pieces[r.pieces.length - 1];
          if (last.angle === 0 && last.len - along >= 0.5) {
            if (last.len > 0) last.dz *= (last.len - along) / last.len;
            last.len -= along;
            continue;
          }
          if (along < 0) { r.pieces.push({ kind: last.kind === 'transition' ? 'mono' : last.kind, len: -along, radius: 0, angle: 0, dz: 0 }); continue; }
        }
      }
      // 其它情况：整条平移
      r.x += dx; r.y += dy;
    }
  }
}

