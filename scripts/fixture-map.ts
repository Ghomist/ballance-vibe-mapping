// 生成一张示例地图（命令行导出的冒烟测试用）：npx tsx scripts/fixture-map.ts out.bvm
import { writeFileSync } from 'node:fs';
import { placeCheckpointOnSeg, placeStartAtEnd } from '../src/model/checkpoint';
import { addObj } from '../src/model/objects';
import { placeBase } from '../src/model/bases';
import { blockToSeg, extendTo, makeBranch, normalize, setSegStyle } from '../src/model/ops';
import { emptyModel } from '../src/model/types';

const m = emptyModel();
const s = blockToSeg(m, 1, 0);
extendTo(m, s, 'b', 120);
placeStartAtEnd(m, s, 'a');
placeCheckpointOnSeg(m, s, 60);
normalize(m);
const last = Object.values(m.segs).find((x) => x.x > 50)!;
last.guard = { L: true, R: true };
const br = makeBranch(m, last.id, 30, 1)!;
extendTo(m, br, 'b', 40);
setSegStyle(m, br, 'sink');
normalize(m);
addObj(m, 'P_Box', 20, 2.5, 2.6);
// 机关底座、挡块、护栏
for (const [t, x] of [['P_Trafo_Wood', 10], ['P_Modul_18', 30]] as const) { const id = addObj(m, t, x, 2.5, t === 'P_Modul_18' ? -0.34 : 0.1)!; placeBase(m, id); }
const fence = addObj(m, 'P_Modul_01', 32.5, 1.85, 0)!;
placeBase(m, fence);
addObj(m, 'P_Modul_30', 102.6, 2.45, -0.5);
normalize(m);
{ const gid = m.nextId++; m.guards[gid] = { id: gid, a: [75, 0, 0], b: [95, 0, 0] }; }
{ const gid = m.nextId++; m.guards[gid] = { id: gid, a: [95, 5, 0], b: [75, 5, 0] }; }
addObj(m, 'P_Extra_Point', 90, 2.5, 2.5);
addObj(m, 'PE_Balloon', 117.5, 2.5, 0);
addObj(m, 'Latern', 40, 7.5, 0);
m.rails[m.nextId] = { id: m.nextId++, x: 120, y: 2.5, z: -0.35, heading: 0, pieces: [{ kind: 'double', len: 20, radius: 0, angle: 0, dz: 0 }] } as never;
writeFileSync(process.argv[2], JSON.stringify(m));
