// 原型的测试场景：专挑刁钻的拼法（错位、非整数宽度、窄路、坡、重叠、缝隙）
import { objType } from '../model/objects';
import { Box, Dir, Doc, Piece, PieceType, Style, emptyDoc } from './types';

class B {
  doc: Doc = emptyDoc();
  box(x: number, y: number, sx: number, sy: number, o: { z?: number; style?: Style; depth?: number; slope?: Box['slope']; open?: number } = {}) {
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'box', x, y, z: o.z ?? 0, sx, sy, depth: o.depth ?? 5, style: o.style ?? 'normal', slope: o.slope, open: o.open };
    return id;
  }
  /** 机关：对准方块中心放在 (ax, ay)，对准方块顶面在 top */
  obj(type: string, ax: number, ay: number, top: number, rot: Dir = 0) {
    const a = objType(type)?.anchor ?? [0, 0, 0];
    const c = [1, 0, -1, 0][rot], s = [0, 1, 0, -1][rot];
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'obj', type, x: ax - (a[0] * c - a[1] * s), y: ay - (a[0] * s + a[1] * c), z: top - a[2], rot };
    return id;
  }
  piece(type: PieceType, x: number, y: number, rot: Dir, z = 0) {
    const id = this.doc.nextId++;
    this.doc.elems[id] = { id, kind: 'piece', type, x, y, z, rot } as Piece;
    return id;
  }
}

export const SCENES: { name: string; build: () => Doc }[] = [
  {
    name: '路口（对齐）',
    build: () => {
      const b = new B();
      // 直路 + T 字 + 十字 + 拐角，全部对齐 5
      b.box(0, 0, 40, 5); b.box(15, 5, 5, 15); // T
      b.box(0, 30, 40, 5); b.box(15, 20, 5, 10); b.box(15, 35, 5, 10); // 十字（上下两段和 T 的竖段相连）
      b.box(50, 0, 5, 30); b.box(55, 25, 20, 5); // 拐角
      return b.doc;
    },
  },
  {
    name: '错位拼接',
    build: () => {
      const b = new B();
      b.box(0, 0, 20, 5); b.box(20, 1.3, 20, 5); // 端面错开 1.3
      b.box(0, 15, 20, 5); b.box(7.37, 20, 5, 12); // T 字口偏到 7.37
      b.box(30, 15, 5, 20); b.box(35, 17.6, 12, 5); // 侧面接一条错开的路
      b.box(0, 40, 13.3, 5); b.box(13.3, 40.003, 10, 5); // 0.003 的错缝：算作连上
      b.box(0, 50, 13.3, 5); b.box(13.35, 50, 10, 5); // 0.05 的缝：不连
      return b.doc;
    },
  },
  {
    name: '各种宽度',
    build: () => {
      const b = new B();
      b.box(0, 0, 30, 1); b.box(0, 5, 30, 3.7); b.box(0, 12, 30, 7);
      b.box(40, 0, 22, 17.5); // 平台
      b.box(62, 6, 15, 5); b.box(47, 17.5, 3.7, 10); // 接普通路、窄路
      b.box(0, 25, 3, 3); // 小方块
      return b.doc;
    },
  },
  {
    name: '凹路与转换',
    build: () => {
      const b = new B();
      b.box(0, 0, 20, 5, { style: 'sink' }); b.box(8, 5, 5, 10, { style: 'sink' }); // 凹路 T
      // 平路 → 平凹转换 → 凹路
      b.box(0, 25, 15, 5); b.piece('transition', 17.5, 27.5, 2); b.box(20, 25, 15, 5, { style: 'sink' });
      // 细边框凹平台，窄转换嵌在边框带里，外面接凹路
      b.box(40, 0, 25, 20, { style: 'ribbon' });
      b.piece('transition-narrow', 51.55, 1.25, 1); b.box(49.05, -12, 5, 12, { style: 'sink' });
      // 凹槽平台 + 凹路
      b.box(0, 40, 20, 15, { style: 'sink' }); b.box(20, 44.1, 12, 5, { style: 'sink' });
      // 凹路开口端（接机关的断口）
      b.box(40, 35, 15, 5, { style: 'sink', open: 1 << 0 }); b.box(60, 35, 15, 5, { style: 'sink', open: 1 << 2 });
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
      // 坡顶插进平台（坡顶和平台一样高）：在平台边沿截断接上
      b.box(80, 0, 5, 15, { slope: { axis: 1, dz: 5 } }); b.box(75, 12, 15, 12, { z: 5 });
      b.box(95, 0, 5, 15, { style: 'sink', slope: { axis: 1, dz: 5 } }); b.box(92, 11, 12, 12, { z: 5, style: 'sink' });
      return b.doc;
    },
  },
  {
    name: '重叠与错层',
    build: () => {
      const b = new B();
      b.box(0, 0, 20, 5); b.box(10, 0, 20, 5); // 同样式重叠：合并
      b.box(0, 15, 25, 5); b.box(10, 13.5, 6, 8, { style: 'sink' }); // 不同样式压上去
      b.box(0, 30, 30, 5); b.box(12, 25, 5, 15, { z: 2 }); // 高出来的 box 穿过路面
      b.box(40, 0, 5, 30); b.box(32, 12, 21, 5, { z: 6, depth: 1.5 }); // 桥从上面跨过
      return b.doc;
    },
  },
  {
    name: '平台与不同样式的路',
    build: () => {
      const b = new B();
      // 平路平台：凹路接进来（自动嵌半宽平凹转换），平路照常接
      b.box(0, 0, 20, 15); b.box(7.5, -10, 5, 10, { style: 'sink' }); b.box(20, 5, 10, 5);
      // 凹槽平台：平路接进来（自动嵌半块下沉坡），凹路照常接
      b.box(40, 0, 20, 15, { style: 'sink' }); b.box(47.5, -10, 5, 10); b.box(60, 5, 10, 5, { style: 'sink' });
      // 细边框平台：凹路接进来（自动嵌窄转换），平路接进来（下沉坡），不对齐格栅的位置
      b.box(80, 0, 22, 17, { style: 'ribbon' }); b.box(83.7, -10, 5, 10, { style: 'sink' }); b.box(102, 6.3, 10, 5);
      // 凹路接平路的侧面（T 字口）
      b.box(0, 30, 30, 5); b.box(12.5, 35, 5, 10, { style: 'sink' });
      // 路插进平台里（不是刚好贴着）：插进去的部分被平台盖住，边沿照样嵌转换件
      b.box(40, 30, 15, 15, { style: 'ribbon' }); b.box(48, 35, 20, 5);
      b.box(40, 50, 15, 15, { style: 'sink' }); b.box(48, 55, 20, 5);
      b.box(40, 70, 15, 15); b.box(48, 75, 20, 5, { style: 'sink' });
      return b.doc;
    },
  },
  {
    name: '机关',
    build: () => {
      const b = new B();
      // 风扇直接放在路上（盖住）；风扇拼在两段路之间
      b.box(0, 0, 30, 5); b.obj('P_Modul_18', 12.5, 2.5, 0);
      b.box(0, 15, 10, 5); b.obj('P_Modul_18', 12.5, 17.5, 0); b.box(15, 15, 10, 5);
      // 变球器嵌在凹槽平台中间；单独放的变球器
      b.box(40, 0, 20, 20, { style: 'sink' }); b.obj('P_Trafo_Wood', 50, 10, -0.7);
      b.obj('P_Trafo_Paper', 70, 10, 0);
      // 栅栏路面；软木桥（挡块）两头接路；跷跷板
      b.box(0, 30, 10, 5); b.obj('P_Modul_01', 12.5, 32.5, 0, 0); b.box(20, 30, 10, 5);
      // 软木桥：两个对准方块是两头那一格路面，中间断开（断口是开口端）
      b.box(40, 30, 10, 5, { style: 'sink', open: 1 }); b.obj('P_Modul_29', 56.86 + 10.97, 32.5, 0, 0); b.box(65.33, 30, 10, 5, { style: 'sink', open: 4 });
      return b.doc;
    },
  },
];
