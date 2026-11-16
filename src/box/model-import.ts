// 导入模型文件：glTF（.glb / .gltf）、FBX、OBJ（可带 .mtl 和贴图）、Virtools（.nmo / .cmo），转成 custom-model 的模型。
// three 的加载器读出来是 Y 朝上，换成 Blender 坐标（Z 朝上）：(x, y, z) → (x, -z, y)；Virtools 是 (x, y, z) → (x, z, y)，面的顶点顺序反过来。
// 贴图缩到 1024 以内转成 dataURL 存进模型（地图码要带着走）。
import * as THREE from 'three';
import { type CustomPart, finishModel, registerModel } from './custom-model';
import { readNmoFile } from '../export/nmo-read';
import { OBJ_TYPES, objType } from '../model/objects';
import type { AssetElem, Elem, Obj, ZoneElem } from './types';
import { type M3, isUpright, splitYaw, toQuat, yawOf } from './xform';
import { CHECK_FLAMES, RESET_POINT, START_FLAMES } from './sectors';

export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.nmo', '.cmo'];
/** 跟着模型一起选 / 拖进来的附属文件（材质库、外部数据、贴图） */
const SIDE_EXTS = ['.mtl', '.bin', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.gif'];
export const MODEL_ACCEPT = [...MODEL_EXTS, ...SIDE_EXTS].join(',');
const ext = (n: string) => (n.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
export const isModelFile = (n: string) => MODEL_EXTS.includes(ext(n));
export const isSideFile = (n: string) => SIDE_EXTS.includes(ext(n));

/** 文件里的一个物体（网格已经按世界矩阵摆好，Blender 坐标） */
interface RawObject { name: string; parts: CustomPart[]; phys?: AssetElem['phys'] }
/**
 * 读出来的文件：objects 是要变成导入模型的物体（一个物体一个元素），elems 是认出来的机关、死亡区（临时编号从 1 开始）；
 * absolute：坐标有意义（NMO 关卡），按原位置放；否则（建模软件的模型）整体放到视图中间。notes：读取时发现的、不影响导入的问题
 */
export interface ImportResult { label: string; objects: RawObject[]; textures: string[]; elems: Elem[]; notes: string[]; absolute: boolean }

const MAX_TEX = 1024;
const MAX_TRIS = 200_000;

/** 图片缩到 MAX_TEX 以内转成 dataURL；有透明像素的存 PNG，其余存 JPEG（小很多） */
function imageToDataUrl(img: CanvasImageSource & { width: number; height: number }, flipY: boolean): string {
  const k = Math.min(1, MAX_TEX / Math.max(img.width, img.height, 1));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (flipY) { g.translate(0, h); g.scale(1, -1); }
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let alpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { alpha = true; break; }
  return alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
}

/** three 的场景（Y 朝上）→ 模型的各部分 */
function fromThree(root: THREE.Object3D, notes: string[]): { objects: RawObject[]; textures: string[] } {
  root.updateMatrixWorld(true);
  const objects: RawObject[] = [], textures: string[] = [];
  const texIdx = new Map<THREE.Texture, number>();
  const tex = (t: THREE.Texture | null | undefined): number | undefined => {
    if (!t) return undefined;
    let i = texIdx.get(t);
    if (i !== undefined) return i;
    const img = t.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img || !img.width) { notes.push('有贴图没读到（文件缺失或格式不支持），用材质颜色代替'); return undefined; }
    try {
      // glTF 的贴图不翻转（flipY = false，UV 左上角为原点）：这里统一按 Blender 的约定，UV 翻 v，图片不动
      i = textures.length;
      textures.push(imageToDataUrl(img, false));
      texIdx.set(t, i);
      return i;
    } catch { notes.push('有贴图读不了，用材质颜色代替'); return undefined; }
  };
  let tris = 0;
  const nm = new THREE.Matrix3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    let g = mesh.geometry as THREE.BufferGeometry;
    if (!g?.attributes.position) return;
    if (g.index) g = g.toNonIndexed();
    const pa = g.attributes.position, na = g.attributes.normal, ta = g.attributes.uv;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: pa.count, materialIndex: 0 }];
    nm.getNormalMatrix(mesh.matrixWorld);
    const flip = mesh.matrixWorld.determinant() < 0;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    // 一个网格物体一个导入模型
    const parts: CustomPart[] = [];
    objects.push({ name: mesh.name || (mesh.parent && mesh.parent !== root ? mesh.parent.name : '') || `物体 ${objects.length + 1}`, parts });
    for (const gr of groups) {
      const mat = mats[gr.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      const map = mat?.map ?? null;
      const flipV = !!map && map.flipY === false;
      const part: CustomPart = { pos: [], uv: [], nrm: [], color: mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8] };
      const ti = tex(map);
      if (ti !== undefined) part.tex = ti;
      if (mat?.transparent && mat.opacity < 1) part.alphaBlend = true;
      else if (mat?.transparent || (mat?.alphaTest ?? 0) > 0) part.alphaTest = true;
      if (mat?.side === THREE.DoubleSide) part.twoSided = true;
      const end = Math.min(pa.count, gr.start + gr.count);
      for (let s = gr.start; s + 2 < end; s += 3) {
        const order = flip ? [0, 2, 1] : [0, 1, 2];
        for (const k of order) {
          const i = s + k;
          v.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld);
          part.pos.push(v.x, -v.z, v.y);
          if (na) { n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); part.nrm.push(n.x, -n.z, n.y); }
          if (ta) part.uv.push(ta.getX(i), flipV ? 1 - ta.getY(i) : ta.getY(i));
          else part.uv.push(0, 0);
        }
        tris++;
      }
      if (!na) part.nrm = faceNormals(part.pos);
      parts.push(part);
    }
    parts.splice(0, parts.length, ...mergeParts(parts));
  });
  if (tris > MAX_TRIS) throw new Error(`模型有 ${tris} 个三角形，太多了（最多 ${MAX_TRIS}）：先在建模软件里减面再导入`);
  return { objects: objects.filter((o) => o.parts.some((p) => p.pos.length >= 9)), textures };
}

/** 没有法线的：按面算 */
function faceNormals(pos: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pos.length; i += 9) {
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    out.push(x, y, z, x, y, z, x, y, z);
  }
  return out;
}

/** 材质一样的部分合在一起（少一些网格） */
function mergeParts(parts: CustomPart[]): CustomPart[] {
  const by = new Map<string, CustomPart>();
  for (const p of parts) {
    const k = JSON.stringify([p.color, p.tex, p.alphaTest, p.alphaBlend, p.twoSided]);
    const q = by.get(k);
    if (!q) { by.set(k, { ...p, pos: [...p.pos], uv: [...p.uv], nrm: [...p.nrm] }); continue; }
    for (const v of p.pos) q.pos.push(v);
    for (const v of p.uv) q.uv.push(v);
    for (const v of p.nrm) q.nrm.push(v);
  }
  return [...by.values()];
}

/** 附属文件按名字查（不分大小写、只看文件名），给加载器的 URL 换成本地的 blob URL */
function sideManager(files: File[]) {
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const mgr = new THREE.LoadingManager();
  const missing = new Set<string>();
  mgr.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? '').toLowerCase();
    const hit = urls.get(name);
    if (!hit) { missing.add(name); return url; }
    return hit;
  });
  return { mgr, missing, dispose: () => { for (const u of urls.values()) URL.revokeObjectURL(u); } };
}

/** 等 three 的贴图加载完（加载器回调时贴图可能还在路上） */
function settle(mgr: THREE.LoadingManager, started: () => boolean): Promise<void> {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    mgr.onLoad = fin;
    mgr.onError = () => {};
    setTimeout(() => { if (!started()) fin(); }, 0);
    setTimeout(fin, 15000);
  });
}

async function loadThree(main: File, side: File[], notes: string[]): Promise<THREE.Object3D> {
  const e = ext(main.name);
  const { mgr, missing, dispose } = sideManager([main, ...side]);
  let pending = 0;
  mgr.onStart = () => { pending++; };
  try {
    let root: THREE.Object3D;
    if (e === '.glb' || e === '.gltf') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const buf = await main.arrayBuffer();
      const gltf = await new GLTFLoader(mgr).parseAsync(e === '.glb' ? buf : new TextDecoder().decode(buf), '');
      root = gltf.scene;
    } else if (e === '.fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      root = new FBXLoader(mgr).parse(await main.arrayBuffer(), '');
    } else {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const text = await main.text();
      const loader = new OBJLoader(mgr);
      const lib = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      const mtlFile = lib ? side.find((f) => f.name.toLowerCase() === lib.split(/[\\/]/).pop()!.toLowerCase()) ?? side.find((f) => ext(f.name) === '.mtl') : side.find((f) => ext(f.name) === '.mtl');
      if (mtlFile) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const mtl = new MTLLoader(mgr).parse(await mtlFile.text(), '');
        mtl.preload();
        loader.setMaterials(mtl);
      } else if (lib) notes.push(`没有一起选上材质库 ${lib}，用默认颜色（把 .mtl 和贴图一起选上或拖进来就有颜色和贴图）`);
      root = loader.parse(text);
    }
    await settle(mgr, () => pending > 0);
    if (missing.size) notes.push(`缺少这些文件：${[...missing].slice(0, 5).join('、')}${missing.size > 5 ? ' 等' : ''}（把它们和模型一起选上或拖进来）`);
    return root;
  } finally { setTimeout(dispose, 1000); }
}

/** Virtools 矩阵（按行，行向量约定）→ Blender 坐标的朝向（3×3 按行，列向量约定）和位置 */
function placementOf(m: number[]): { B: M3; pos: [number, number, number] } {
  const S = [0, 2, 1];
  const B = [0, 1, 2].flatMap((a) => [0, 1, 2].map((b) => m[S[b] * 4 + S[a]])) as M3;
  return { B, pos: [m[12], m[14], m[13]] };
}
/** 机关类型按物体名认：P_Box_01_01 → P_Box（最长的那个前缀） */
const ELEM_TYPES = OBJ_TYPES.filter((t) => t.cat !== 'deco').map((t) => t.type).sort((a, b) => b.length - a.length);
const typeByName = (n: string) => ELEM_TYPES.find((t) => n === t || n.startsWith(`${t}_`));

/**
 * Virtools 文件：按组认出机关（P_*、终点气球，小节按 Sector_XX）、死亡区（DepthTestCubes）；
 * 其余显示着的、带网格的物体各成一个导入模型，路面（Phys_Floors，木头的声音算木路面）、钢轨（Phys_FloorRails）、挡块记下导出类型。
 * 起点、小节盘点、重生点要和路面一起摆，不导入
 */
async function loadNmo(main: File, notes: string[]): Promise<{ objects: RawObject[]; elems: Elem[] }> {
  const doc = await readNmoFile(new Uint8Array(await main.arrayBuffer()));
  const groupsOf = new Map<number, string[]>();
  for (const g of doc.groups) for (const i of g.objects) { const l = groupsOf.get(i) ?? []; l.push(g.name); groupsOf.set(i, l); }
  const objects: RawObject[] = [], elems: Elem[] = [];
  let hidden = 0, tris = 0, flames = 0, unknown = 0, nextId = 1;
  for (const o of doc.objects) {
    const gs = groupsOf.get(o.index) ?? [];
    const has = (g: string) => gs.includes(g);
    const sec = gs.map((g) => /^Sector_0*(\d+)$/.exec(g)).find(Boolean);
    // 机关：组名就是类型（P_Box、P_Modul_17…），没归组的按名字认
    const type = gs.find((g) => objType(g) && objType(g)!.cat !== 'deco') ?? typeByName(o.name);
    if (type || /^P[SCR]_/.test(o.name) || has('PS_Levelstart') || has('PC_Checkpoints') || has('PR_Resetpoints')) {
      if (!type) { unknown++; continue; }
      const { B, pos } = placementOf(o.matrix);
      const e: Obj = { id: nextId++, kind: 'obj', type, x: pos[0], y: pos[1], z: pos[2], rot: 0, ...(objType(type)?.part ? {} : { noBase: true, noStopper: true }) };
      // 小节：两火 PC_TwoFlames_{n} 激活第 n + 1 小节，重生点 PR_Resetpoint_{n} 在第 n 小节；其余机关看 Sector_XX 组
      const num = +(/_0*(\d+)$/.exec(o.name)?.[1] ?? NaN);
      if (type === CHECK_FLAMES) { e.sector = Number.isFinite(num) ? num + 1 : 2; flames++; }
      else if (type === RESET_POINT) { e.sector = Number.isFinite(num) ? num : 1; flames++; }
      else if (type === START_FLAMES) flames++;
      else if (sec && type !== 'PE_Balloon') e.sector = +sec[1];
      if (isUpright(B)) {
        const { ang, quarter } = splitYaw(yawOf(B));
        e.rot = quarter;
        // 朝向坐标系转了 ang：坐标也要转进去
        if (ang) { const r = (-ang * Math.PI) / 180; e.ang = ang; e.x = pos[0] * Math.cos(r) - pos[1] * Math.sin(r); e.y = pos[0] * Math.sin(r) + pos[1] * Math.cos(r); }
      } else e.q = toQuat(B);
      elems.push(e);
      continue;
    }
    const m = o.mesh === null ? undefined : doc.meshes.get(o.mesh);
    if (!m || !m.faces.length) continue;
    const M = o.matrix;
    const W = (x: number, y: number, z: number) => [x * M[0] + y * M[4] + z * M[8] + M[12], x * M[1] + y * M[5] + z * M[9] + M[13], x * M[2] + y * M[6] + z * M[10] + M[14]];
    // 死亡区，或者隐藏的挡块（隐形挡块）：取网格的世界包围盒（Blender 坐标）
    const istop = !o.visible && has('Phys_FloorStopper') && !has('DepthTestCubes');
    if (has('DepthTestCubes') || istop) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i * 3 < m.pos.length; i++) {
        const p = W(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]), b = [p[0], p[2], p[1]];
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b[k]); mx[k] = Math.max(mx[k], b[k]); }
      }
      const z: ZoneElem = { id: nextId++, kind: 'zone', x: mn[0], y: mn[1], z: mx[2], sx: Math.max(0.1, mx[0] - mn[0]), sy: Math.max(0.1, mx[1] - mn[1]), depth: Math.max(0.1, mx[2] - mn[2]), ...(istop ? { stop: true } : {}) };
      elems.push(z);
      continue;
    }
    if (!o.visible) { hidden++; continue; }
    const N = (x: number, y: number, z: number) => { const a = x * M[0] + y * M[4] + z * M[8], b = x * M[1] + y * M[5] + z * M[9], c = x * M[2] + y * M[6] + z * M[10], l = Math.hypot(a, b, c) || 1; return [a / l, b / l, c / l]; };
    const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
    const parts = new Map<string, CustomPart>();
    for (let f = 0; f * 3 < m.faces.length; f++) {
      const slot = m.mtls[m.faceMtl[f]] ?? null;
      const mat = slot === null ? undefined : doc.materials.get(slot);
      const file = mat?.texture != null ? doc.textures.get(mat.texture) : undefined;
      const key = mat ? `${slot}` : '-';
      let part = parts.get(key);
      if (!part) {
        part = { pos: [], uv: [], nrm: [], color: mat ? [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]] : [0.8, 0.8, 0.8] };
        if (file) { part.tex = file; part.color = [1, 1, 1]; }
        if (mat?.alphaBlend) part.alphaBlend = true;
        if (mat?.alphaTest) part.alphaTest = true;
        if (mat?.twoSided) part.twoSided = true;
        parts.set(key, part);
      }
      // 左手系换右手系：顶点顺序反过来（行列式为负的物体本身就镜像了，再反一次）
      const tri = (det < 0 ? [0, 1, 2] : [2, 1, 0]).map((k) => m.faces[f * 3 + k]);
      if (tri.some((vi) => vi * 3 + 2 >= m.pos.length)) continue;
      const nrm: number[] = [];
      for (const vi of tri) {
        const p = W(m.pos[vi * 3], m.pos[vi * 3 + 1], m.pos[vi * 3 + 2]);
        part.pos.push(p[0], p[2], p[1]);
        part.uv.push(m.uv[vi * 2] ?? 0, -(m.uv[vi * 2 + 1] ?? 0));
        if (m.nml) { const n = N(m.nml[vi * 3], m.nml[vi * 3 + 1], m.nml[vi * 3 + 2]); nrm.push(n[0], n[2], n[1]); }
      }
      if (m.nml) for (const v of nrm) part.nrm.push(v);
      else for (const v of faceNormals(part.pos.slice(-9))) part.nrm.push(v);
      tris++;
    }
    const phys: RawObject['phys'] = has('Phys_FloorRails') ? 'rail' : has('Phys_Floors') ? (has('Sound_HitID_02') || has('Sound_RollID_02') ? 'wood' : 'floor') : has('Phys_FloorStopper') ? 'floor' : undefined;
    objects.push({ name: o.name, parts: [...parts.values()], ...(phys ? { phys } : {}) });
  }
  if (hidden) notes.push(`跳过了 ${hidden} 个隐藏的物体`);
  if (flames) notes.push(`起点 / 小节的火焰和重生点（${flames} 个）按文件里的小节号导入；盘点的路面是文件里的网格`);
  if (unknown) notes.push(`${unknown} 个认不出类型的机关没有导入`);
  if (tris > MAX_TRIS) throw new Error(`模型有 ${tris} 个三角形，太多了（最多 ${MAX_TRIS}）`);
  if (!objects.length && !elems.length) throw new Error(doc.objects.length ? '文件里的物体都没有网格（或者都是隐藏的）' : '文件里没有 3D 物体');
  if (objects.some((o) => o.parts.some((p) => typeof p.tex === 'string'))) notes.push('贴图用游戏自带的同名贴图（Ballance/Textures 里有的才显示得出来）');
  const machines = elems.filter((e) => e.kind === 'obj').length, istops = elems.filter((e) => e.kind === 'zone' && e.stop).length, zones = elems.length - machines - istops;
  if (machines - flames) notes.push(`认出了 ${machines - flames} 个机关（按组和名字），已经关掉自动生成的专属路块和挡块，免得和文件里的路面重复`);
  if (zones) notes.push(`${zones} 个死亡区按包围盒导入`);
  if (istops) notes.push(`${istops} 个隐藏的挡块按包围盒导入成隐形挡块`);
  return { objects, elems };
}

/** 读一个模型文件（side：一起选 / 拖进来的附属文件）；读不了抛错，message 能直接给用户看 */
export async function importModelFile(main: File, side: File[] = []): Promise<ImportResult> {
  const e = ext(main.name);
  if (!MODEL_EXTS.includes(e)) throw new Error(`不支持 ${e || '这种'} 格式，能导入的是 ${MODEL_EXTS.join(' ')}`);
  if (main.size > 80 * 1024 * 1024) throw new Error('文件太大了（超过 80 MB）');
  const notes: string[] = [];
  const label = main.name.replace(/\.[^.]+$/, '').slice(0, 40) || '模型';
  try {
    if (e === '.nmo' || e === '.cmo') { const r = await loadNmo(main, notes); return { label, ...r, textures: [], notes: [...new Set(notes)], absolute: true }; }
    const r = fromThree(await loadThree(main, side, notes), notes);
    if (!r.objects.length) throw new Error('文件里没有找到三角形网格');
    return { label, ...r, elems: [], notes: [...new Set(notes)], absolute: false };
  } catch (err) {
    const m = String((err as Error)?.message ?? err).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120);
    // three 的加载器报错是英文的技术信息：包一层说明
    throw new Error(/[一-鿿]/.test(m) ? m : `文件解析失败，可能已损坏或者不是有效的 ${e.slice(1).toUpperCase()} 文件（${m}）`);
  }
}

/** 整个导入的包围盒（Blender 坐标，缩放前） */
export function importBounds(r: ImportResult): { min: number[]; max: number[] } {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number) => { mn[0] = Math.min(mn[0], x); mn[1] = Math.min(mn[1], y); mn[2] = Math.min(mn[2], z); mx[0] = Math.max(mx[0], x); mx[1] = Math.max(mx[1], y); mx[2] = Math.max(mx[2], z); };
  for (const o of r.objects) for (const p of o.parts) for (let i = 0; i + 2 < p.pos.length; i += 3) add(p.pos[i], p.pos[i + 1], p.pos[i + 2]);
  for (const e of r.elems) if (e.kind === 'obj' || e.kind === 'zone') add(e.x, e.y, e.z);
  return { min: mn, max: mx };
}
export const importTris = (r: ImportResult) => r.objects.reduce((s, o) => s + o.parts.reduce((t, p) => t + p.pos.length / 9, 0), 0);

/**
 * 读出来的东西 → 地图元素（临时编号从 1 开始，交给 pasteElems 换成地图里的编号）：每个物体登记成一个导入模型，原点在它自己的底面中心，
 * 元素放在原来的位置；scale 以世界原点缩放。group：给所有元素绑成一组（不绑传 undefined）
 */
export function buildImport(r: ImportResult, scale = 1, group?: number): Elem[] {
  const out: Elem[] = [];
  let id = 1;
  for (const e of r.elems) {
    const c = JSON.parse(JSON.stringify(e)) as Elem;
    c.id = id++;
    if (c.kind === 'obj' || c.kind === 'zone') { c.x *= scale; c.y *= scale; c.z *= scale; }
    if (c.kind === 'zone') { c.sx *= scale; c.sy *= scale; c.depth *= scale; }
    if (group !== undefined) c.group = group;
    out.push(c);
  }
  for (const o of r.objects) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of o.parts) for (let i = 0; i < p.pos.length; i++) { const k = i % 3; mn[k] = Math.min(mn[k], p.pos[i]); mx[k] = Math.max(mx[k], p.pos[i]); }
    if (!mn.every(Number.isFinite)) continue;
    // 只带这个物体用到的贴图
    const used = [...new Set(o.parts.map((p) => p.tex).filter((t): t is number => typeof t === 'number'))];
    const parts = o.parts.map((p) => (typeof p.tex === 'number' ? { ...p, tex: used.indexOf(p.tex) } : p));
    const name = registerModel(finishModel(o.name.slice(0, 40) || r.label, parts, used.map((i) => r.textures[i]), scale));
    const a: AssetElem = { id: id++, kind: 'asset', name, x: ((mn[0] + mx[0]) / 2) * scale, y: ((mn[1] + mx[1]) / 2) * scale, z: mn[2] * scale, rot: 0, ...(o.phys ? { phys: o.phys } : {}) };
    if (group !== undefined) a.group = group;
    out.push(a);
  }
  return out;
}
