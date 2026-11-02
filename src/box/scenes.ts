// 原型的演示 / 测试场景：每个场景把一类功能的各种拼法摆在一起（错位、非整数宽度、坡、重叠、转换、机关…）
import { objType } from '../model/objects';
import { Box, Dir, Doc, Piece, PieceType, Style, emptyDoc } from './types';

class B {
  doc: Doc = emptyDoc();
  /** 后面添加的东西都平移这么多（把几组拼法摆在同一个场景里） */
  private ox = 0;
  private oy = 0;
  at(ox: number, oy: number) { this.ox = ox; this.oy = oy; return this; }
  box(x: number, y: number, sx: number, sy: number, o: { z?: number; style?: Style; depth?: number; slope?: Box['slope']; open?: number } = {}) {
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'box', x: x + this.ox, y: y + this.oy, z: o.z ?? 0, sx, sy, depth: o.depth ?? 5, style: o.style ?? 'normal', slope: o.slope, open: o.open };
    return id;
  }
  /** 机关：对准方块中心放在 (ax, ay)，对准方块顶面在 top */
  obj(type: string, ax: number, ay: number, top: number, rot: Dir = 0) {
    const a = objType(type)?.anchor ?? [0, 0, 0];
    const c = [1, 0, -1, 0][rot], s = [0, 1, 0, -1][rot];
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'obj', type, x: ax + this.ox - (a[0] * c - a[1] * s), y: ay + this.oy - (a[0] * s + a[1] * c), z: top - a[2], rot };
    return id;
  }
  piece(type: PieceType, x: number, y: number, rot: Dir, z = 0) {
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'piece', type, x: x + this.ox, y: y + this.oy, z, rot } as Piece;
    return id;
  }
}

/** 起点 / 小节盘点的路口离中心多远 */
const START_PORT = 12.3861, CHECK_PORT = 9.924;

export const SCENES: { name: string; build: () => Doc }[] = [
  {
    name: '完整小关卡',
    build: () => {
      const b = new B();
      // 起点 → 风扇（拼在两段路之间）→ 小节盘点 → 坡（高头插进平台，平台掏空）→ 平台中间放变球器
      // → 凹路（自动嵌半宽平凹转换）→ 软木桥（两头是开口的凹路）→ 平凹转换 → 平路 → 终点气球
      b.piece('start', 0, 2.5, 0);
      const r0 = START_PORT;
      b.box(r0, 0, 15, 5); b.obj('P_Modul_18', r0 + 17.5, 2.5, 0); b.box(r0 + 20, 0, 15, 5);
      const c = r0 + 35 + CHECK_PORT;
      b.piece('check', c, 2.5, 0);
      const r1 = c + CHECK_PORT;
      b.box(r1, 0, 10, 5); b.box(r1 + 10, 0, 15, 5, { slope: { axis: 0, dz: 5 } });
      const px = r1 + 23;
      b.box(px, -7.5, 20, 20, { z: 5 }); b.obj('P_Trafo_Wood', px + 12.5, 2.5, 5);
      b.box(px + 20, 0, 15, 5, { z: 5, style: 'sink', open: 1 });
      const cork = px + 35 - 2.5 + 9.36; // 软木桥原点：左边的对准方块是凹路的最后一格
      b.obj('P_Modul_29', cork + 10.97, 2.5, 5);
      const r2 = cork + 10.97 - 2.5;
      b.box(r2, 0, 15, 5, { z: 5, style: 'sink', open: 4 });
      b.piece('transition', r2 + 17.5, 2.5, 0, 5);
      b.box(r2 + 20, 0, 15, 5, { z: 5 });
      // 终点气球：对准方块是路的最后一格，飞船在路的前方
      b.obj('PE_Balloon', r2 + 32.5, 2.5, 5, 2);
      return b.doc;
    },
  },
  {
    name: '路面拼接',
    build: () => {
      const b = new B();
      // 对齐 5 的直路、T 字、十字、拐角
      b.at(0, 0);
      b.box(0, 0, 40, 5); b.box(15, 5, 5, 15);
      b.box(0, 30, 40, 5); b.box(15, 20, 5, 10); b.box(15, 35, 5, 10);
      b.box(50, 0, 5, 30); b.box(55, 25, 20, 5);
      // 错位：端面错开 1.3、T 字口偏到 7.37、侧面接错开的路、0.003 的错缝（连上）、0.05 的缝（不连）
      b.at(95, 0);
      b.box(0, 0, 20, 5); b.box(20, 1.3, 20, 5);
      b.box(0, 15, 20, 5); b.box(7.37, 20, 5, 12);
      b.box(30, 15, 5, 20); b.box(35, 17.6, 12, 5);
      b.box(0, 40, 13.3, 5); b.box(13.3, 40.003, 10, 5);
      b.box(0, 50, 13.3, 5); b.box(13.35, 50, 10, 5);
      // 各种宽度：1、3.7、7，平台接普通路和窄路，3×3 小方块
      b.at(0, 70);
      b.box(0, 0, 30, 1); b.box(0, 5, 30, 3.7); b.box(0, 12, 30, 7);
      b.box(40, 0, 22, 17.5); b.box(62, 6, 15, 5); b.box(47, 17.5, 3.7, 10);
      b.box(0, 25, 3, 3);
      // 重叠与错层：同样式重叠合并、不同样式压上去、高出来的路穿过路面、桥从上面跨过
      b.at(95, 75);
      b.box(0, 0, 20, 5); b.box(10, 0, 20, 5);
      b.box(0, 15, 25, 5); b.box(10, 13.5, 6, 8, { style: 'sink' });
      b.box(0, 30, 30, 5); b.box(12, 25, 5, 15, { z: 2 });
      b.box(40, 0, 5, 30); b.box(32, 12, 21, 5, { z: 6, depth: 1.5 });
      return b.doc;
    },
  },
  {
    name: '样式与转换',
    build: () => {
      const b = new B();
      // 凹路 T；平路 → 平凹转换 → 凹路；细边框平台嵌窄转换接凹路；凹槽平台接凹路；凹路开口端
      b.at(0, 0);
      b.box(0, 0, 20, 5, { style: 'sink' }); b.box(8, 5, 5, 10, { style: 'sink' });
      b.box(0, 25, 15, 5); b.piece('transition', 17.5, 27.5, 2); b.box(20, 25, 15, 5, { style: 'sink' });
      b.box(40, 0, 25, 20, { style: 'ribbon' });
      b.piece('transition-narrow', 51.55, 1.25, 1); b.box(49.05, -12, 5, 12, { style: 'sink' });
      b.box(0, 40, 20, 15, { style: 'sink' }); b.box(20, 44.1, 12, 5, { style: 'sink' });
      b.box(40, 35, 15, 5, { style: 'sink', open: 1 << 0 }); b.box(60, 35, 15, 5, { style: 'sink', open: 1 << 2 });
      // 不同样式的路接平台：自动在边框带里嵌转换件（贴着、插进去、T 字口都行）
      b.at(0, 80);
      b.box(0, 0, 20, 15); b.box(7.5, -10, 5, 10, { style: 'sink' }); b.box(20, 5, 10, 5);
      b.box(40, 0, 20, 15, { style: 'sink' }); b.box(47.5, -10, 5, 10); b.box(60, 5, 10, 5, { style: 'sink' });
      b.box(80, 0, 22, 17, { style: 'ribbon' }); b.box(83.7, -10, 5, 10, { style: 'sink' }); b.box(102, 6.3, 10, 5);
      b.box(0, 30, 30, 5); b.box(12.5, 35, 5, 10, { style: 'sink' });
      b.box(40, 30, 15, 15, { style: 'ribbon' }); b.box(48, 35, 20, 5);
      b.box(75, 30, 15, 15, { style: 'sink' }); b.box(83, 35, 20, 5);
      b.box(110, 30, 15, 15); b.box(118, 35, 20, 5, { style: 'sink' });
      return b.doc;
    },
  },
  {
    name: '坡',
    build: () => {
      const b = new B();
      b.box(0, 0, 15, 5); b.box(15, 0, 15, 5, { slope: { axis: 0, dz: 5 } }); b.box(30, 0, 15, 5, { z: 5 });
      // 凹路坡
      b.box(0, 15, 10, 5, { style: 'sink' }); b.box(10, 15, 12.3, 5, { style: 'sink', slope: { axis: 0, dz: 3.7 } }); b.box(22.3, 15, 10, 5, { style: 'sink', z: 3.7 });
      // 平台接一条比它窄的坡，坡接坡
      b.box(50, 0, 20, 20); b.box(57.3, 20, 5, 10, { slope: { axis: 1, dz: 2.5 } }); b.box(57.3, 30, 5, 6, { z: 2.5, slope: { axis: 1, dz: 2.5 } }); b.box(55, 36, 10, 8, { z: 5 });
      // 坡的高头插进平台（坡顶和平台一样高）：平台掏空，坡从槽里升上来
      b.box(80, 0, 5, 15, { slope: { axis: 1, dz: 5 } }); b.box(75, 12, 15, 12, { z: 5 });
      b.box(95, 0, 5, 15, { style: 'sink', slope: { axis: 1, dz: 5 } }); b.box(92, 11, 12, 12, { z: 5, style: 'sink' });
      // 坡的低头插进平台（坡底和平台一样高）：直接叠在平台上
      b.box(110, 0, 15, 12); b.box(115, 8, 5, 15, { slope: { axis: 1, dz: 4 } });
      return b.doc;
    },
  },
  {
    name: '机关与盘点',
    build: () => {
      const b = new B();
      // 风扇直接放在路上（盖住）；风扇拼在两段路之间
      b.box(0, 0, 30, 5); b.obj('P_Modul_18', 12.5, 2.5, 0);
      b.box(0, 15, 10, 5); b.obj('P_Modul_18', 12.5, 17.5, 0); b.box(15, 15, 10, 5);
      // 变球器嵌在凹槽平台中间；单独放的变球器
      b.box(40, 0, 20, 20, { style: 'sink' }); b.obj('P_Trafo_Wood', 50, 10, -0.7);
      b.obj('P_Trafo_Paper', 70, 10, 0);
      // 栅栏：横跨路面，栅栏路面的第二格伸到路外面（栅栏被推过去的地方）
      b.box(0, 30, 10, 5); b.obj('P_Modul_01', 12.5, 32.5, 0, 1); b.box(15, 30, 10, 5);
      // 软木桥：两个对准方块是两头那一格路面，中间断开（断口是开口端）
      b.box(40, 30, 10, 5, { style: 'sink', open: 1 }); b.obj('P_Modul_29', 56.86 + 10.97, 32.5, 0, 0); b.box(65.33, 30, 10, 5, { style: 'sink', open: 4 });
      // 盘点：起点接一头；小节盘点两头都接、只接一头、都不接
      b.at(0, 55);
      b.piece('start', 0, 2.5, 0); b.box(START_PORT, 0, 15, 5);
      b.piece('check', START_PORT + 15 + CHECK_PORT, 2.5, 0); b.box(START_PORT + 15 + 2 * CHECK_PORT, 0, 15, 5);
      b.box(72.5, 0, 5, 10); b.piece('check', 75, 10 + CHECK_PORT, 1);
      b.piece('check', 100, 2.5, 0);
      return b.doc;
    },
  },
];
