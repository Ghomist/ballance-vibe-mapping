// 导入模型文件：glTF（.glb / .gltf）、FBX、OBJ（可带 .mtl 和贴图）、Virtools（.nmo / .cmo），转成 custom-model 的模型。
// three 的加载器读出来是 Y 朝上，换成 Blender 坐标（Z 朝上）：(x, y, z) → (x, -z, y)；Virtools 是 (x, y, z) → (x, z, y)，面的顶点顺序反过来。
// 贴图缩到 1024 以内转成 dataURL 存进模型（地图码要带着走）。
import * as THREE from 'three';
import { type CustomModel, type CustomPart, finishModel } from './custom-model';
import { readNmoFile } from '../export/nmo-read';

export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.nmo', '.cmo'];
/** 跟着模型一起选 / 拖进来的附属文件（材质库、外部数据、贴图） */
const SIDE_EXTS = ['.mtl', '.bin', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.gif'];
export const MODEL_ACCEPT = [...MODEL_EXTS, ...SIDE_EXTS].join(',');
const ext = (n: string) => (n.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
export const isModelFile = (n: string) => MODEL_EXTS.includes(ext(n));
export const isSideFile = (n: string) => SIDE_EXTS.includes(ext(n));

/** 读取时就发现的问题（不影响导入的） */
export interface ImportResult { model: CustomModel; notes: string[] }

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
function fromThree(root: THREE.Object3D, notes: string[]): { parts: CustomPart[]; textures: string[] } {
  root.updateMatrixWorld(true);
  const parts: CustomPart[] = [], textures: string[] = [];
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
  });
  if (tris > MAX_TRIS) throw new Error(`模型有 ${tris} 个三角形，太多了（最多 ${MAX_TRIS}）：先在建模软件里减面再导入`);
  return { parts: mergeParts(parts), textures };
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

/** Virtools 文件：所有显示着的、带网格的物体，按世界矩阵摆好合成一个模型 */
async function loadNmo(main: File, notes: string[]): Promise<{ parts: CustomPart[]; textures: string[] }> {
  const doc = await readNmoFile(new Uint8Array(await main.arrayBuffer()));
  const parts = new Map<string, CustomPart>();
  let hidden = 0, tris = 0;
  for (const o of doc.objects) {
    const m = o.mesh === null ? undefined : doc.meshes.get(o.mesh);
    if (!m || !m.faces.length) continue;
    if (!o.visible) { hidden++; continue; }
    const M = o.matrix;
    const W = (x: number, y: number, z: number) => [x * M[0] + y * M[4] + z * M[8] + M[12], x * M[1] + y * M[5] + z * M[9] + M[13], x * M[2] + y * M[6] + z * M[10] + M[14]];
    const N = (x: number, y: number, z: number) => { const a = x * M[0] + y * M[4] + z * M[8], b = x * M[1] + y * M[5] + z * M[9], c = x * M[2] + y * M[6] + z * M[10], l = Math.hypot(a, b, c) || 1; return [a / l, b / l, c / l]; };
    const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
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
      const order = det < 0 ? [0, 1, 2] : [2, 1, 0];
      const tri: number[] = [];
      for (const k of order) {
        const vi = m.faces[f * 3 + k];
        if (vi * 3 + 2 >= m.pos.length) { tri.length = 0; break; }
        tri.push(vi);
      }
      if (tri.length !== 3) continue;
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
  }
  if (hidden) notes.push(`跳过了 ${hidden} 个隐藏的物体`);
  if (tris > MAX_TRIS) throw new Error(`模型有 ${tris} 个三角形，太多了（最多 ${MAX_TRIS}）`);
  if (!parts.size) throw new Error(doc.objects.length ? '文件里的物体都没有网格（或者都是隐藏的）' : '文件里没有 3D 物体');
  const used = [...parts.values()].filter((p) => typeof p.tex === 'string');
  if (used.length) notes.push('贴图用游戏自带的同名贴图（Ballance/Textures 里有的才显示得出来）');
  return { parts: [...parts.values()], textures: [] };
}

/** 读一个模型文件（side：一起选 / 拖进来的附属文件）；读不了抛错，message 能直接给用户看 */
export async function importModelFile(main: File, side: File[] = [], scale = 1): Promise<ImportResult> {
  const e = ext(main.name);
  if (!MODEL_EXTS.includes(e)) throw new Error(`不支持 ${e || '这种'} 格式，能导入的是 ${MODEL_EXTS.join(' ')}`);
  if (main.size > 80 * 1024 * 1024) throw new Error('文件太大了（超过 80 MB）');
  const notes: string[] = [];
  const label = main.name.replace(/\.[^.]+$/, '').slice(0, 40) || '模型';
  let got: { parts: CustomPart[]; textures: string[] };
  try {
    got = e === '.nmo' || e === '.cmo' ? await loadNmo(main, notes) : fromThree(await loadThree(main, side, notes), notes);
  } catch (err) {
    const m = String((err as Error)?.message ?? err).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120);
    // three 的加载器报错是英文的技术信息：包一层说明
    throw new Error(/[一-鿿]/.test(m) ? m : `文件解析失败，可能已损坏或者不是有效的 ${e.slice(1).toUpperCase()} 文件（${m}）`);
  }
  return { model: finishModel(label, got.parts, got.textures, scale), notes: [...new Set(notes)] };
}
