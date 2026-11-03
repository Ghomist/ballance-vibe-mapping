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
import { AssetElem, Doc, Obj, Piece, ZoneElem, toWorld, yawDeg } from './types';
import { fromQuat, mul, rotZ } from './xform';

/** 机关 / 特殊路面的世界位置与朝向（倾斜或拉伸过的给出完整的矩阵，拉伸是模型本地 X、Y 的缩放） */
function placement(e: Obj | AssetElem) {
  const pos = toWorld(e, [e.x, e.y, e.z]).map(r5) as [number, number, number];
  const sc = e.kind === 'asset' && e.scale && (e.scale[0] !== 1 || e.scale[1] !== 1) ? e.scale : null;
  if (!e.q && !sc) return { pos, rotZ: r5(yawDeg(e)) };
  const R = e.q ? fromQuat(e.q) : rotZ(yawDeg(e));
  const M = sc ? mul(R, [sc[0], 0, 0, 0, sc[1], 0, 0, 0, 1]) : R;
  return { pos, rotZ: 0, rot3: M.map(r5), ...(sc ? { uvStretch: sc } : {}) };
}

/** 死亡区的长方体（世界坐标，12 个三角形） */
export function zoneTris(z: ZoneElem): number[] {
  const c = [[z.x, z.y], [z.x + z.sx, z.y], [z.x + z.sx, z.y + z.sy], [z.x, z.y + z.sy]];
  const v = [...c.map(([x, y]) => toWorld(z, [x, y, z.z])), ...c.map(([x, y]) => toWorld(z, [x, y, z.z - z.depth]))];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, c2, d] of quads) for (const i of [a, b, c2, a, c2, d]) out.push(...v[i]);
  return out;
}

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
    const gm = guardFromRoute({ pts: g.pts, outs: g.outs }, { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) });
    if (!gm || !gm.pos.length) continue;
    meshes.push({ name: `A_Rail_BVM_Guard_${String(++gi).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: gm.pos.map(r5) }] });
    for (const n of gm.nails) nails.push({ asset: n.name, kind: 'deco', pos: n.pos.map(r5) as [number, number, number], rotZ: n.rotZ });
  }

  // ---- 挡块：合成一个物体 ----
  const sp: number[] = [], su: number[] = [];
  for (const o of objs) {
    if (o.noStopper || o.q) continue;
    const w = toWorld(o, [o.x, o.y, o.z]);
    const st = stopperMesh({ id: 0, cat: 'module', type: o.type, x: w[0], y: w[1], z: w[2], rot: yawDeg(o) });
    if (st) { sp.push(...st.pos.map(r5)); su.push(...st.uv.map(r5)); }
  }
  if (sp.length) meshes.push({ name: 'A_Stopper_BVM_01', kind: 'stopper', parts: [{ mat: 'Stopper', pos: sp, uv: su }] });

  // ---- 死亡区：一个一个物体，导出时隐藏 ----
  let zi = 0;
  for (const z of elems) if (z.kind === 'zone') meshes.push({ name: `DepthTestCubes_${String(++zi).padStart(2, '0')}`, kind: 'zone', parts: [{ mat: 'Zone', pos: zoneTris(z).map(r5) }] });

  // ---- 资产（盘点路面、专属路块）与占位符（火焰、重生点） ----
  const assets: SceneAsset[] = [...nails];
  const elements: SceneElement[] = [];
  for (const [id, parts] of solved.assets) {
    const owner = doc.elems[id];
    for (const p of parts) {
      const pos = p.pos.map(r5) as [number, number, number];
      if (p.kind === 'asset') { assets.push({ asset: p.name, kind: assetKind(p.name), pos, rotZ: p.rotZ, ...(p.crop ? { crop: p.crop } : {}) }); continue; }
      const cp = owner?.kind === 'piece' ? owner : null;
      // 起点四火不分小节；小节盘点的两火属于上一个小节，重生点属于本小节
      const sector = p.name === 'PS_FourFlames' || !cp ? undefined : p.name === 'PC_TwoFlames' ? sectorOf(cp) - 1 : sectorOf(cp);
      elements.push({ type: p.name, sector, pos, rotZ: p.rotZ });
    }
  }

  // ---- 特殊路面（资产库模型） ----
  for (const e of elems) if (e.kind === 'asset') assets.push({ asset: e.name, kind: assetKind(e.name), ...placement(e) });

  // ---- 机关与装饰：小节按机关自己记的（放的时候取顶栏选的小节，属性面板里可改），超出就算最后一个小节 ----
  const nearSector = (o: Obj) => Math.min(Math.max(1, o.sector ?? 1), sectors);
  for (const o of objs) {
    const t = objType(o.type);
    if (!t) { warnings.push(`未知物件类型 ${o.type}`); continue; }
    const pl = placement(o);
    if (t.cat === 'deco') assets.push({ asset: o.type, kind: assetKind(o.type), ...pl });
    else elements.push({ type: o.type, sector: o.type === 'PE_Balloon' ? undefined : nearSector(o), ...pl });
  }

  return { format: 'bvm-scene', version: 1, sectors, meshes, assets, elements, warnings };
}

/** box 文档 → .nmo 文件内容 */
export async function exportBoxNmo(doc: Doc): Promise<{ data: Uint8Array; warnings: string[] }> {
  const desc = exportBoxScene(doc);
  const nmo = buildNmoDoc(desc, await loadNmoLib());
  return { data: await writeNmo(nmo), warnings: desc.warnings };
}
