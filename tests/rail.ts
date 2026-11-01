// 钢轨：倒转、圆弧上分隔、首尾合并、跟着路面伸缩
import { appendRail, canAppend, pieceLength, Rail, railEnd, reverseRail, splitRail } from '../src/model/rail';
import { followRails } from '../src/model/rail-follow';
import { blockToSeg, extendTo, normalize } from '../src/model/ops';
import { Model, cloneModel, endPos } from '../src/model/types';

type Check = (c: boolean, msg: string) => void;
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

function sample(): Rail {
  return { id: 1, x: 0, y: 0, z: 0, heading: 0, pieces: [
    { kind: 'double', len: 10, radius: 0, angle: 0, dz: 1 },
    { kind: 'double', len: 0, radius: 5, angle: 90, dz: 0 },
    { kind: 'mono', len: 0, radius: 5, angle: 720, dz: -10 },
  ] };
}

export function railEditScenarios(emptyModel: () => Model, check: Check, scenario: (n: string, f: () => void) => void) {
  scenario('钢轨倒过来走：起终点互换，再倒回来不变', () => {
    const r = sample(), E = railEnd(r);
    const q: Rail = JSON.parse(JSON.stringify(r));
    reverseRail(q);
    check(near(q.x, E.x) && near(q.y, E.y) && near(q.z, E.z), '倒转后起点 = 原终点');
    const E2 = railEnd(q);
    check(near(E2.x, 0) && near(E2.y, 0) && near(E2.z, 0) && near((((E2.heading + 180) % 360) + 360) % 360, 0), `倒转后终点 = 原起点，朝向相反（${JSON.stringify(E2)}）`);
    reverseRail(q);
    const E3 = railEnd(q);
    check(near(q.x, 0) && near(q.y, 0) && near(E3.x, E.x) && near(E3.y, E.y) && near(E3.z, E.z), '倒两次回到原样');
  });

  scenario('圆弧、螺旋上也能分隔，合并后形状不变', () => {
    const r = sample(), E = railEnd(r);
    const total = r.pieces.reduce((a, p) => a + pieceLength(p), 0);
    const tail = splitRail(r, 10 + pieceLength(r.pieces[1]) / 2, 2);
    check(!!tail, '在圆弧中间分隔');
    check(!!tail && canAppend(r, tail), '分出来的两条首尾相接');
    if (tail) {
      const t2 = splitRail(tail, 20, 3);
      check(!!t2, '在螺旋中间分隔');
      if (t2) appendRail(tail, t2);
      appendRail(r, tail);
    }
    const E2 = railEnd(r);
    check(near(E2.x, E.x, 1e-6) && near(E2.y, E.y, 1e-6) && near(E2.z, E.z, 1e-6), '合并回来终点不变');
    check(near(r.pieces.reduce((a, p) => a + pieceLength(p), 0), total, 1e-6), '总长不变');
  });

  scenario('路面伸缩时，接在端头的钢轨跟着伸缩', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 20);
    normalize(m);
    const seg = m.segs[s];
    const [bx, by] = endPos(seg, 'b');
    // 钢轨从路的 b 端出去 15，另一条钢轨从远处朝着路的 a 端过来
    const [ax, ay] = endPos(seg, 'a');
    m.rails[50] = { id: 50, x: bx, y: by, z: -0.0, heading: 0, pieces: [{ kind: 'double', len: 15, radius: 0, angle: 0, dz: 0 }] };
    m.rails[51] = { id: 51, x: ax - 12, y: ay, z: 0, heading: 0, pieces: [{ kind: 'double', len: 12, radius: 0, angle: 0, dz: 0 }] };
    m.nextId = Math.max(m.nextId, 52);
    const before = cloneModel(m);
    extendTo(m, s, 'b', 25); // 路的 b 端往外伸 5
    normalize(m);
    followRails(before, m);
    const r = m.rails[50];
    const [nbx] = endPos(m.segs[s], 'b');
    check(near(r.x, nbx, 1e-6) && near(r.pieces[0].len, 10, 1e-6), `钢轨起点跟到新的路端、变短 5（起点 ${r.x}，长 ${r.pieces[0].len}）`);
    check(near(railEnd(r).x, bx + 15, 1e-6), '钢轨远端不动');
    check(near(m.rails[51].pieces[0].len, 12, 1e-6), '另一头的钢轨不受影响');
    // 再缩回来：钢轨变长
    const b2 = cloneModel(m);
    extendTo(m, s, 'b', 15);
    normalize(m);
    followRails(b2, m);
    check(near(m.rails[50].pieces[0].len, 20, 1e-6), `路缩短，钢轨变长到 20（${m.rails[50].pieces[0].len}）`);
    // 重复调用不会再动
    const again = JSON.stringify(m.rails);
    followRails(b2, m);
    check(JSON.stringify(m.rails) === again, '重复跟随结果不变');
  });

  scenario('只改钢轨（路没动）时不会被拉回去', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 20);
    normalize(m);
    const [bx, by] = endPos(m.segs[s], 'b');
    m.rails[50] = { id: 50, x: bx, y: by, z: 0, heading: 0, pieces: [{ kind: 'double', len: 15, radius: 0, angle: 0, dz: 0 }] };
    m.nextId = Math.max(m.nextId, 51);
    const before = cloneModel(m);
    m.rails[50].x += 3;
    followRails(before, m);
    check(near(m.rails[50].x, bx + 3), '路面不动时钢轨保持修改');
  });
}
