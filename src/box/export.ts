// box 文档导出：展开成场景描述（与旧版 exportScene 的格式相同），再交给 nmo-scene 生成 .nmo。
import { assetKind, type SceneAsset, type SceneDesc, type SceneElement, type SceneMesh, type SceneMeshPart } from '../export/scene';
import { buildNmoDoc } from '../export/nmo-scene';
import { writeNmo } from '../export/nmo';
import { loadNmoLib } from '../export/nmo-lib';
import { objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { solve } from './solve';
import { buildRail } from '../geom/rail';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
import { Doc, Obj, Piece, anchorRects } from './types';

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export function exportBoxScene(doc: Doc): SceneDesc {
  const warnings: string[] = [];
  const elems = Object.values(doc.elems);
  const start = elems.find((e): e is Piece => e.kind === 'piece' && e.type === 'start');
  const checks = elems.filter((e): e is Piece => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
  const objs = elems.filter((e): e is Obj => e.kind === 'obj');
  if (!start) warnings.push('没有起点：游戏里无法开始这一关');
  if (!objs.some((o) => o.type === 'PE_Balloon')) warnings.push('没有终点气球（PE_Balloon）');
  const sectorOf = (p: Piece) => (p.type === 'start' ? 1 : p.sector ?? checks.indexOf(p) + 2);
  const sectors = 1 + checks.length;

  const solved = solve(doc);

  // ---- 路面：每个元素一个物体 ----
  const meshes: SceneMesh[] = [];
  let fi = 0;
  for (const m of solved.meshes.values()) {
    const parts: SceneMeshPart[] = [];
    for (const [mat, part] of Object.entries(m.parts)) {
      if (!part || !part.pos.length) continue;
      parts.push({ mat, pos: part.pos.map(r5), uv: part.uv.map(r5) });
    }
    if (parts.length) meshes.push({ name: `A_Floor_BVM_${String(++fi).padStart(2, '0')}`, kind: 'floor', parts });
  }

  // ---- 钢轨：一条一个物体 ----
  let ri = 0;
  for (const r of elems) {
    if (r.kind !== 'rail') continue;
    const rm = buildRail(r);
    if (rm.pos.length) meshes.push({ name: `A_Rail_BVM_${String(++ri).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: rm.pos.map(r5) }] });
  }

  // ---- 护栏：每段一个钢轨物体，铆钉是装饰 ----
  let gi = 0;
  const nails: SceneAsset[] = [];
  for (const g of elems) {
    if (g.kind !== 'guard') continue;
    const gm = guardFromRoute({ pts: g.pts, outs: g.outs }, DEFAULT_SETTINGS);
    if (!gm || !gm.pos.length) continue;
    meshes.push({ name: `A_Rail_BVM_Guard_${String(++gi).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: gm.pos.map(r5) }] });
    for (const n of gm.nails) nails.push({ asset: n.name, kind: 'deco', pos: n.pos.map(r5) as [number, number, number], rotZ: n.rotZ });
  }

  // ---- 挡块：合成一个物体 ----
  const sp: number[] = [], su: number[] = [];
  for (const o of objs) {
    if (o.noStopper) continue;
    const st = stopperMesh({ id: 0, cat: 'module', type: o.type, x: o.x, y: o.y, z: o.z, rot: o.rot * 90 });
    if (st) { sp.push(...st.pos.map(r5)); su.push(...st.uv.map(r5)); }
  }
  if (sp.length) meshes.push({ name: 'A_Stopper_BVM_01', kind: 'stopper', parts: [{ mat: 'Stopper', pos: sp, uv: su }] });

  // ---- 资产（盘点路面、专属路块）与占位符（火焰、重生点） ----
  const assets: SceneAsset[] = [...nails];
  const elements: SceneElement[] = [];
  for (const [id, parts] of solved.assets) {
    const owner = doc.elems[id];
    for (const p of parts) {
      const pos = p.pos.map(r5) as [number, number, number];
      if (p.kind === 'asset') { assets.push({ asset: p.name, kind: assetKind(p.name), pos, rotZ: p.rotZ }); continue; }
      const cp = owner?.kind === 'piece' ? owner : null;
      // 起点四火不分小节；小节盘点的两火属于上一个小节，重生点属于本小节
      const sector = p.name === 'PS_FourFlames' || !cp ? undefined : p.name === 'PC_TwoFlames' ? sectorOf(cp) - 1 : sectorOf(cp);
      elements.push({ type: p.name, sector, pos, rotZ: p.rotZ });
    }
  }

  // ---- 机关与装饰 ----
  // 小节：离机关（对准方块）最近的盘点（起点算第 1 小节）；以后可以按路面连通关系判断
  const cps = [start, ...checks].filter((p): p is Piece => !!p);
  const nearSector = (o: Obj) => {
    const a = anchorRects(o)[0];
    const [x, y] = a ? [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2] : [o.x, o.y];
    if (!cps.length) return 1;
    return sectorOf(cps.reduce((b, c) => (Math.hypot(c.x - x, c.y - y) < Math.hypot(b.x - x, b.y - y) ? c : b)));
  };
  for (const o of objs) {
    const t = objType(o.type);
    if (!t) { warnings.push(`未知物件类型 ${o.type}`); continue; }
    const pos: [number, number, number] = [r5(o.x), r5(o.y), r5(o.z)];
    if (t.cat === 'deco') assets.push({ asset: o.type, kind: assetKind(o.type), pos, rotZ: o.rot * 90 });
    else elements.push({ type: o.type, sector: o.type === 'PE_Balloon' ? undefined : nearSector(o), pos, rotZ: o.rot * 90 });
  }

  return { format: 'bvm-scene', version: 1, sectors, meshes, assets, elements, warnings };
}

/** box 文档 → .nmo 文件内容 */
export async function exportBoxNmo(doc: Doc): Promise<{ data: Uint8Array; warnings: string[] }> {
  const desc = exportBoxScene(doc);
  const nmo = buildNmoDoc(desc, await loadNmoLib());
  return { data: await writeNmo(nmo), warnings: desc.warnings };
}
