// box 文档导出：展开成场景描述（与旧版 exportScene 的格式相同），再交给 nmo-scene 生成 .nmo。
import { assetKind, type SceneAsset, type SceneDesc, type SceneElement, type SceneMesh, type SceneMeshPart } from '../export/scene';
import { buildNmoDoc } from '../export/nmo-scene';
import { writeNmo } from '../export/nmo';
import { loadNmoLib } from '../export/nmo-lib';
import { nmoDocToGlb, nmoDocToObj, textureFiles, zipStore } from '../export/model3d';
import { objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { solve } from './solve';
import { buildRail, mergeRails } from '../geom/rail';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
import { assetInfo, meshScale, tileOf } from './asset-info';
import { AssetElem, Doc, Obj, Piece, ZoneElem, toWorld, yawDeg } from './types';
import { fromQuat, mul, rotZ } from './xform';

/** 机关 / 特殊路面的世界位置与朝向（倾斜或拉伸过的给出完整的矩阵，拉伸是模型本地 X、Y 的缩放） */
function placement(e: Obj | AssetElem) {
  const pos = toWorld(e, [e.x, e.y, e.z]).map(r5) as [number, number, number];
  const sc = e.kind === 'asset' && e.scale && (e.scale[0] !== 1 || e.scale[1] !== 1) ? e.scale : null;
  const an = e.kind === 'asset' ? e.name : '';
  // 花纹重复的木制件沿长度方向是接长 / 截断（tile），那个方向不缩放
  const tile = e.kind === 'asset' ? tileOf(an, e.scale, e.off) : null;
  if (!e.q && !sc) return { pos, rotZ: r5(yawDeg(e)), ...(tile ? { tile } : {}) };
  const R = e.q ? fromQuat(e.q) : rotZ(yawDeg(e));
  const ms = sc ? meshScale(an, sc) : null;
  const M = ms ? mul(R, [ms[0], 0, 0, 0, ms[1], 0, 0, 0, 1]) : R;
  return { pos, rotZ: 0, rot3: M.map(r5), ...(ms && (ms[0] !== 1 || ms[1] !== 1) ? { uvStretch: ms } : {}), ...(tile ? { tile } : {}) };
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

  // ---- 钢轨：头尾相接的合成一个物体，接头处法线和 UV 才连续 ----
  const postDepth = { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) }.guardPostDepth;
  const railMeshes = elems.flatMap((r) => (r.kind === 'rail' && !r.road ? [buildRail(r, postDepth)] : [])).filter((m) => m.pos.length);
  mergeRails(railMeshes).forEach((pos, i) => {
    meshes.push({ name: `A_Rail_BVM_${String(i + 1).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: pos.map(r5) }] });
  });

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
    const st = stopperMesh({ id: 0, cat: 'module', type: o.type, x: w[0], y: w[1], z: w[2], rot: yawDeg(o), stopOff: o.stopOff });
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
  // 云层：游戏只处理叫 SkyLayer 的那一个物体，多出来的进了游戏是黑底，所以只导出第一个
  const skies = elems.filter((e): e is AssetElem => e.kind === 'asset' && !!assetInfo(e.name)?.sky);
  if (skies.length > 1) warnings.push(`一张图只能有一个云层，只导出第一个（${assetInfo(skies[0].name)!.label}），其余 ${skies.length - 1} 个不导出`);
  for (const e of elems) if (e.kind === 'asset' && (e === skies[0] || !skies.includes(e))) assets.push({ asset: e.name, kind: assetKind(e.name), ...placement(e) });

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

// ---- 通用 3D 模型（.obj / .glb）：和 .nmo 同一份文档，导出的也是占位符 ----

/** 读一张游戏贴图（public/textures），没有就是 null */
async function fetchTexture(file: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}textures/${file}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch { return null; }
}

/** 贴图转 PNG（glTF 只认 PNG / JPEG）：.bmp 交给浏览器解码，.tga 用 three 的 TGALoader（它的行序是从下往上，要翻过来） */
async function toPng(file: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    let src: CanvasImageSource, w: number, h: number;
    if (/\.tga$/i.test(file)) {
      const { TGALoader } = await import('three/examples/jsm/loaders/TGALoader.js');
      const t = new TGALoader().parse(bytes.slice().buffer) as unknown as { data: Uint8Array; width: number; height: number };
      w = t.width; h = t.height;
      const img = new ImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(t.data.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      src = await createImageBitmap(img);
    } else {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
      src = bmp; w = bmp.width; h = bmp.height;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(src, 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}

/** box 文档 → .zip（.obj + .mtl + 贴图原文件） */
export async function exportBoxObj(doc: Doc, base: string): Promise<{ data: Uint8Array; warnings: string[] }> {
  const desc = exportBoxScene(doc);
  const nmo = buildNmoDoc(desc, await loadNmoLib());
  const { obj, mtl } = nmoDocToObj(nmo, base);
  const enc = new TextEncoder();
  const files = [{ name: `${base}.obj`, data: enc.encode(obj) }, { name: `${base}.mtl`, data: enc.encode(mtl) }];
  for (const f of textureFiles(nmo)) {
    const b = await fetchTexture(f);
    if (b) files.push({ name: `textures/${f}`, data: b });
  }
  return { data: zipStore(files), warnings: desc.warnings };
}

/** box 文档 → .glb（贴图转成 PNG 嵌在里面） */
export async function exportBoxGlb(doc: Doc): Promise<{ data: Uint8Array; warnings: string[] }> {
  const desc = exportBoxScene(doc);
  const nmo = buildNmoDoc(desc, await loadNmoLib());
  const images = new Map<string, Uint8Array>();
  await Promise.all(textureFiles(nmo).map(async (f) => {
    const b = await fetchTexture(f);
    const png = b && (await toPng(f, b));
    if (png) images.set(f, png);
  }));
  return { data: nmoDocToGlb(nmo, images), warnings: desc.warnings };
}
