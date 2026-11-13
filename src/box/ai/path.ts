// 路径工具：像「乌龟画图」一样沿着一条赛道往前铺。模型只说「往前 20 的平路 → 右转 → 10 的凹路 → 盘点 → ……」，
// 每一段放在哪、多宽的块、平路和凹路之间要不要转换件、盘点和飞船朝哪边、钢轨从哪里接出去，都在这里算。
// 大模型算坐标很容易错（差半格、方向反了、忘了转换），所以把几何交给这里，它只管设计。
//
// 光标：赛道铺到哪了（下一段从这里开始）——位置是路的端面中心，z 是路面顶面高度，dir 是前进方向。
import { assetInfo } from '../asset-info';
import { edgeAt } from '../guard';
import { translateElem } from '../ops';
import { solve } from '../solve';
import { AssetElem, Box, CP_PORT, Dir, Doc, Elem, Obj, Piece, RailElem, anchorRects, railPath } from '../types';
import { objType } from '../../model/objects';
import { DEFAULT_SETTINGS } from '../../model/types';
import type { RailPiece } from '../../model/rail';

export type Ball = 'wood' | 'paper' | 'stone';
export interface Cursor { x: number; y: number; z: number; dir: Dir; style: Box['style']; width: number; sector: number; /** 玩家这时是什么球（按铺的顺序经过的变球器算） */ ball?: Ball; /** 光标后面紧挨着的那块路面（接着铺时，转换、机关、护栏要用） */ prev?: number }
type Args = Record<string, unknown>;
export class PathError extends Error {}

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const STYLES = ['normal', 'sink', 'ribbon'];
/** 每张图上次铺到哪了：下一次调用不给 from 就接着铺 */
const last = new WeakMap<Doc, Cursor>();
export const lastCursor = (doc: Doc) => last.get(doc) ?? null;
/** 记号：铺到某处时起个名字记下来（mark），以后从那里再铺一条岔路、或者绕一圈接回来（goto / from.mark） */
const marks = new WeakMap<Doc, Map<string, Cursor>>();
export const markNames = (doc: Doc) => [...(marks.get(doc)?.keys() ?? [])];
/** 每个元素是铺哪一小节的时候放的（只在这次打开期间记着；get_section 用） */
const sectorTags = new WeakMap<Doc, Map<number, number>>();
export const sectorTagOf = (doc: Doc, id: number) => sectorTags.get(doc)?.get(id);
const BALL_NAME: Record<Ball, string> = { wood: '木球', paper: '纸球', stone: '石球' };
const markOf = (doc: Doc, name: unknown): Cursor => {
  const m = marks.get(doc)?.get(String(name));
  if (!m) throw new PathError(`没有叫「${String(name)}」的记号${markNames(doc).length ? `，现有的：${markNames(doc).join('、')}` : '（还没有记过任何记号）'}`);
  return { ...m };
};

const num = (o: Args, k: string, def?: number): number => {
  const v = o[k];
  if (v === undefined || v === null) { if (def === undefined) throw new PathError(`缺少 ${k}`); return def; }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e4) throw new PathError(`${k} 要是合理的数字`);
  return n;
};
const pos = (o: Args, k: string, def?: number) => { const n = num(o, k, def); if (n <= 0) throw new PathError(`${k} 要大于 0`); return n; };
const turnOf = (o: Args): 1 | -1 => { if (o.to !== 'left' && o.to !== 'right') throw new PathError('to 要是 left 或 right'); return o.to === 'left' ? 1 : -1; };

export interface PathStepOut { step: number; do: string; ids: number[]; note?: string }
export interface PathOut { steps: PathStepOut[]; cursor: Cursor; changed: number[]; error?: string; length: number; /** 球种上说不通的地方 */ logic?: string[]; /** 新铺的路和原有的路叠在一起的地方 */ collisions?: string[] }

/** 沿前进方向放一块路面：从光标所在的端面起，长 len、宽 w（左右居中） */
function roadBox(c: Cursor, len: number, w: number, style: Box['style'], rise: number, depth: number): Omit<Box, 'id'> {
  const along = c.dir % 2 === 0;
  const sx = along ? len : w, sy = along ? w : len;
  const x = along ? (c.dir === 0 ? c.x : c.x - len) : c.x - w / 2, y = along ? c.y - w / 2 : c.dir === 1 ? c.y : c.y - len;
  const b: Omit<Box, 'id'> = { kind: 'box', x: r3(x), y: r3(y), z: r3(c.z), sx: r3(sx), sy: r3(sy), depth, style };
  if (rise) {
    // slope.dz 是坐标大的一端比小的一端高多少，z 是坐标小的那一端的高度
    const up = c.dir === 0 || c.dir === 1;
    b.slope = { axis: (c.dir % 2) as 0 | 1, dz: r3(up ? rise : -rise) };
    if (!up) b.z = r3(c.z + rise);
  }
  return b;
}

/**
 * 把一次 build_path 拆成几小次（界面上一步一步铺给人看）：连着的钢轨步骤要在同一次里（它们是一条钢轨），其余每步一次。
 * 第一次带着 from，后面的接着铺。
 */
export function splitPathCall(a: Args): Args[] {
  const steps = a.steps;
  if (!Array.isArray(steps) || steps.length < 2) return [a];
  const isRail = (s: unknown) => ['rail', 'rail_turn', 'spiral'].includes(String((s as Args | null)?.do));
  const chunks: unknown[][] = [];
  for (const s of steps) { const l = chunks[chunks.length - 1]; if (l && isRail(s) && isRail(l[l.length - 1])) l.push(s); else chunks.push([s]); }
  let n = 0;
  return chunks.map((ch, i) => { const o: Args = { ...(i === 0 && a.from ? { from: a.from } : {}), steps: ch, step_offset: n }; n += ch.length; return o; });
}

export function buildPath(doc: Doc, a: Args): PathOut {
  const steps = a.steps;
  if (!Array.isArray(steps) || !steps.length) throw new PathError('steps 要是非空数组');
  if (steps.length > 60) throw new PathError('一次最多 60 步，分几次调用（下一次不给 from 就接着铺）');
  const tags = sectorTags.get(doc) ?? sectorTags.set(doc, new Map()).get(doc)!;
  const add = <T extends Elem>(e: Omit<T, 'id'>): T => { const n = { ...e, id: doc.nextId++ } as T; doc.elems[n.id] = n; tags.set(n.id, c?.sector ?? 1); return n; };
  const logic: string[] = [];
  const checks = () => Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'check').length;

  // ---- 从哪开始 ----
  let c: Cursor;
  const from = a.from as Args | undefined;
  if (from && typeof from === 'object' && from.mark !== undefined) {
    c = markOf(doc, from.mark);
    // 从记号出发可以换个方向（岔路）
    if (from.dir !== undefined) { const d = num(from, 'dir'); if (![0, 1, 2, 3].includes(d)) throw new PathError('from.dir 只能是 0、1、2、3'); c.dir = d as Dir; }
  } else if (from && typeof from === 'object') {
    const d = num(from, 'dir', 0);
    if (![0, 1, 2, 3].includes(d)) throw new PathError('from.dir 只能是 0、1、2、3');
    const style = (from.style ?? 'normal') as Box['style'];
    if (!STYLES.includes(style)) throw new PathError('from.style 只能是 normal / sink / ribbon');
    c = { x: num(from, 'x'), y: num(from, 'y'), z: num(from, 'z', 0), dir: d as Dir, style, width: pos(from, 'width', 5), sector: Math.round(num(from, 'sector', 1 + checks())) };
  } else {
    const l = last.get(doc);
    if (!l) throw new PathError('这张图还没用 build_path 铺过路：要给 from（起点的位置、高度和方向）');
    c = { ...l };
  }

  const out: PathStepOut[] = [], changed: number[] = [];
  let total = 0, error: string | undefined;
  /** 正在接的钢轨（连着的几步钢轨合成一条） */
  let rail: RailElem | null = null, railHeading = 0;
  /** 上一步铺的路面（放东西、护栏时用）；接着上一次铺时沿用上一次的 */
  const pe = (!from || from.mark !== undefined) && c.prev !== undefined ? doc.elems[c.prev] : null;
  let prevRoad: Box | null = pe && pe.kind === 'box' ? pe : null;
  /** 界面一步一步执行时，这次调用里的第一步其实是整条里的第几步 */
  const offset = Math.max(0, Math.round(Number(a.step_offset) || 0));
  const fwd = (d: number) => { c.x = r3(c.x + DX[c.dir] * d); c.y = r3(c.y + DY[c.dir] * d); };
  const endRail = () => {
    if (!rail) return;
    const h = ((railHeading % 360) + 360) % 360, q = Math.round(h / 90);
    if (Math.abs(h - q * 90) > 0.5) throw new PathError(`钢轨结束时的方向是 ${r3(h)}°，不是正方向（0 / 90 / 180 / 270）：后面接不了路。把转弯的角度凑成 90 的倍数`);
    const p = railPath(rail), e = p[p.length - 1];
    c.x = r3(e.x); c.y = r3(e.y); c.z = r3(e.z); c.dir = (q % 4) as Dir;
    rail = null;
  };
  const road = (len: number, w: number, style: Box['style'], rise = 0, depth = 5): Box => {
    const b = add<Box>(roadBox(c, len, w, style, rise, depth));
    fwd(len); c.z = r3(c.z + rise); c.style = style; c.width = w; total += len;
    prevRoad = b;
    return b;
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as Args, kind = String(s?.do);
    const ids: number[] = [];
    let note: string | undefined;
    try {
      if (!s || typeof s !== 'object') throw new PathError('每一步要是一个对象');
      const isRail = kind === 'rail' || kind === 'rail_turn' || kind === 'spiral';
      if (!isRail) endRail();
      if (kind === 'start') {
        if (Object.values(doc.elems).some((e) => e.kind === 'piece' && e.type === 'start')) throw new PathError('地图里已经有起点了');
        ids.push(add<Piece>({ kind: 'piece', type: 'start', x: c.x, y: c.y, z: c.z, rot: c.dir }).id);
        fwd(CP_PORT.start); c.style = 'normal'; c.width = 5; c.sector = 1; c.ball = 'wood'; prevRoad = null;
      } else if (kind === 'road' || kind === 'platform') {
        const len = pos(s, 'length'), w = pos(s, 'width', kind === 'platform' ? 15 : c.width === 5 || kind === 'road' ? 5 : c.width);
        const style = (s.style ?? c.style) as Box['style'];
        if (!STYLES.includes(style)) throw new PathError('style 只能是 normal / sink / ribbon');
        const rise = num(s, 'rise', 0);
        if (Math.abs(rise) > len * 0.8) throw new PathError(`坡太陡了：长 ${len} 升 ${rise}。把 length 加长，或者分几段`);
        // 平路和凹路之间自动垫一块平凹转换（宽 5 的才有）
        const flip = (c.style === 'normal' && style === 'sink') || (c.style === 'sink' && style === 'normal');
        if (flip && prevRoad && c.width === 5 && w === 5) {
          const t = add<Piece>({ kind: 'piece', type: 'transition', x: r3(c.x + DX[c.dir] * 2.5), y: r3(c.y + DY[c.dir] * 2.5), z: c.z, rot: (style === 'sink' ? (c.dir + 2) % 4 : c.dir) as Dir });
          ids.push(t.id); fwd(5); total += 5;
          note = '前面自动垫了一块平凹转换（长 5）';
        } else if (flip && prevRoad) note = '平路和凹路直接相接了（只有宽 5 的路之间才能放平凹转换）';
        ids.push(road(len, w, style, rise, pos(s, 'depth', 5)).id);
      } else if (kind === 'turn') {
        const t = turnOf(s), w = c.width;
        // 拐角是一块 w×w 的方块；从它侧面的中间出去。那里已经有路了（岔路口：另一条路从这里拐过、或者直着穿过）就不再叠一块
        const mx = c.x + DX[c.dir] * w / 2, my = c.y + DY[c.dir] * w / 2;
        const there = Object.values(doc.elems).find((e): e is Box => e.kind === 'box' && !e.ang && !e.q && !e.slope && Math.abs(e.z - c.z) < 0.05 && mx > e.x + 0.5 && mx < e.x + e.sx - 0.5 && my > e.y + 0.5 && my < e.y + e.sy - 0.5);
        if (there) { fwd(w); prevRoad = there; note = `拐角处已经有路面 #${there.id}，直接从它旁边拐出去（岔路口）`; }
        else ids.push(road(w, w, c.style).id);
        fwd(-w / 2);
        c.dir = ((c.dir + (t === 1 ? 1 : 3)) % 4) as Dir;
        fwd(w / 2);
      } else if (kind === 'checkpoint') {
        if (c.width !== 5) note = '盘点两边的路是 5 宽的，前面这段不是 5 宽，接口处会有台阶';
        ids.push(add<Piece>({ kind: 'piece', type: 'check', x: r3(c.x + DX[c.dir] * CP_PORT.check), y: r3(c.y + DY[c.dir] * CP_PORT.check), z: c.z, rot: c.dir }).id);
        fwd(CP_PORT.check * 2); total += CP_PORT.check * 2;
        c.sector = 2 + checks() - 1; c.style = 'normal'; c.width = 5; prevRoad = null;
        note = `${note ? `${note}；` : ''}从这里开始是第 ${c.sector} 小节`;
      } else if (kind === 'balloon') {
        if (Object.values(doc.elems).some((e) => e.kind === 'obj' && e.type === 'PE_Balloon')) throw new PathError('地图里已经有终点飞船了');
        // 飞船接在最后一格路上：前面不是路（或者不够一格）就先补一格
        if (!prevRoad) ids.push(road(5, 5, 'normal').id);
        const o = add<Obj>({ kind: 'obj', type: 'PE_Balloon', x: 0, y: 0, z: 0, rot: ((c.dir + 2) % 4) as Dir });
        const cell = anchorRects(o)[0];
        translateElem(o, [c.x - DX[c.dir] * 2.5 - (cell.x0 + cell.x1) / 2, c.y - DY[c.dir] * 2.5 - (cell.y0 + cell.y1) / 2, c.z - cell.top]);
        ids.push(o.id);
        note = '飞船在路的尽头前方，赛道到此结束';
      } else if (kind === 'connect') {
        // 自动接到一个指定的路口上：to 是那个路口的位置（路的端面中心、高度）和到达时的前进方向
        const to = s.to as Args | undefined;
        if (!to || typeof to !== 'object') throw new PathError('connect 要给 to：{x, y, z, dir}（要接上去的路口，以及到达那里时的前进方向）');
        const tx = num(to, 'x'), ty = num(to, 'y'), tz = num(to, 'z', c.z), td = num(to, 'dir');
        if (![0, 1, 2, 3].includes(td)) throw new PathError('to.dir 只能是 0、1、2、3');
        const w = c.width, a = (tx - c.x) * DX[c.dir] + (ty - c.y) * DY[c.dir], b = -(tx - c.x) * DY[c.dir] + (ty - c.y) * DX[c.dir];
        const rel = (td - c.dir + 4) % 4, E = 0.02;
        /** 路线：几段直路的长度，中间夹着转弯 */
        let legs: number[] = [], turns: ('left' | 'right')[] = [];
        const side: 'left' | 'right' = b >= 0 ? 'left' : 'right', back: 'left' | 'right' = b >= 0 ? 'right' : 'left';
        const fail = (why: string): never => { throw new PathError(`从这里接不到那个路口：${why}。现在的位置相对路口：还差前方 ${r3(a)}、左方 ${r3(b)}（负数是后方 / 右方），到达方向要求是 ${td}。先用 road / turn 走到一个合适的位置再 connect`); };
        if (rel === 0) {
          if (Math.abs(b) < E) { if (a < -E) fail('路口在正后方'); legs = [a]; }
          else { if (Math.abs(b) < w - E || a < w - E) fail('横向错开太少或者前方距离太短，拐不过去'); legs = [(a - w) / 2, Math.abs(b) - w, (a - w) / 2]; turns = [side, back]; }
        } else if (rel === 1 || rel === 3) {
          const need: 'left' | 'right' = rel === 1 ? 'left' : 'right';
          if (need !== side || a < w / 2 - E || Math.abs(b) < w / 2 - E) fail('路口不在拐一个弯就能到的位置');
          legs = [a - w / 2, Math.abs(b) - w / 2]; turns = [need];
        } else {
          if (Math.abs(b) < w - E) fail('要掉头，但横向错开不够一个路宽');
          const l1 = Math.max(a, 0) + 5;
          legs = [l1, Math.abs(b) - w, l1 - a]; turns = [side, side];
        }
        // 高度差放在最长的那段直路上做成坡
        const dz = tz - c.z, long = legs.indexOf(Math.max(...legs));
        if (Math.abs(dz) > 0.01 && Math.abs(dz) > legs[long] * 0.6) fail(`高度差 ${r3(dz)} 太大，这点距离做不出不太陡的坡`);
        legs.forEach((len, k) => {
          if (len > E) ids.push(road(len, w, c.style, k === long && Math.abs(dz) > 0.01 ? dz : 0).id);
          if (k < turns.length) { ids.push(road(w, w, c.style).id); fwd(-w / 2); c.dir = ((c.dir + (turns[k] === 'left' ? 1 : 3)) % 4) as Dir; fwd(w / 2); }
        });
        if (Math.hypot(c.x - tx, c.y - ty) > 0.05) fail('算出来的路线没对上（内部错误）');
        c.x = r3(tx); c.y = r3(ty); c.z = r3(tz);
        note = `接上了：${legs.filter((l) => l > E).length} 段路、${turns.length} 个弯${Math.abs(dz) > 0.01 ? `，其中一段是${dz > 0 ? '上' : '下'}坡` : ''}`;
      } else if (kind === 'mark') {
        const name = String(s.name ?? '').trim();
        if (!name) throw new PathError('mark 要给 name');
        const pr0 = prevRoad as Box | null;
        (marks.get(doc) ?? marks.set(doc, new Map()).get(doc)!).set(name, { ...c, prev: pr0 ? pr0.id : undefined });
        note = `记下了「${name}」：以后用 {do: "goto", name: "${name}"} 或 from: {mark: "${name}"} 回到这里`;
      } else if (kind === 'goto') {
        c = markOf(doc, s.name);
        if (s.dir !== undefined) { const d = num(s, 'dir'); if (![0, 1, 2, 3].includes(d)) throw new PathError('dir 只能是 0、1、2、3'); c.dir = d as Dir; }
        const pe2 = c.prev !== undefined ? doc.elems[c.prev] : null;
        prevRoad = pe2 && pe2.kind === 'box' ? pe2 : null;
      } else if (kind === 'gap') {
        fwd(pos(s, 'length')); c.z = r3(c.z - num(s, 'drop', 0)); prevRoad = null;
        note = '空了一段（落差 / 需要别的东西来连）';
      } else if (isRail) {
        const k = (s.kind ?? 'double') as RailPiece['kind'];
        if (k !== 'double' && k !== 'mono') throw new PathError('kind 只能是 double / mono');
        let piece: RailPiece;
        if (kind === 'rail') piece = { kind: k, len: pos(s, 'length'), radius: 0, angle: 0, dz: num(s, 'rise', 0) };
        else if (kind === 'rail_turn') { const ang = pos(s, 'angle', 90); piece = { kind: k, len: 0, radius: pos(s, 'radius', 10), angle: turnOf(s) * ang, dz: num(s, 'rise', 0) }; }
        else { const turns = pos(s, 'turns', 1); if (turns > 6) throw new PathError('螺旋最多 6 圈'); piece = { kind: k, len: 0, radius: pos(s, 'radius', 10), angle: turnOf(s) * 360 * turns, dz: num(s, 'rise', 0) }; }
        if (piece.radius && piece.radius < 4) throw new PathError('弯轨半径不要小于 4');
        if (!rail) { rail = add<RailElem>({ kind: 'rail', x: c.x, y: c.y, z: c.z, heading: c.dir * 90, pieces: [] }); railHeading = c.dir * 90; }
        for (const p of rail.pieces) p.kind = k;
        rail.pieces.push(piece);
        railHeading += piece.angle;
        total += piece.len || (Math.abs(piece.angle) * Math.PI * piece.radius) / 180;
        ids.push(rail.id);
        prevRoad = null;
        if (i === steps.length - 1) endRail();
      } else if (kind === 'object') {
        const t = objType(String(s.type));
        if (!t) throw new PathError(`不认识的 type「${String(s.type)}」`);
        if (t.type === 'PE_Balloon') throw new PathError('飞船用 {do: "balloon"}');
        if (t.unique && Object.values(doc.elems).some((e) => e.kind === 'obj' && e.type === t.type)) throw new PathError(`${t.label} 全图只能有一个`);
        const mod = t.cat === 'module';
        // 木栅栏是横在路上的，其它机关顺着路；flip 是掉个头
        const rot = ((c.dir + (t.type === 'P_Modul_01' ? 1 : 0) + (s.flip ? 2 : 0)) % 4) as Dir;
        const o = add<Obj>({ kind: 'obj', type: t.type, x: 0, y: 0, z: 0, rot, ...(mod ? { sector: c.sector } : {}) });
        ids.push(o.id);
        // 球种：经过变球器就换；机关和现在的球对不上就提醒（玩家到这里时过不去、或者机关白放）
        const ball: Ball = c.ball ?? 'wood', tf = /^P_Trafo_(Paper|Stone|Wood)$/.exec(t.type);
        const warn = (w: string) => { logic.push(`第 ${i + 1 + offset} 步 ${t.label}：${w}`); note = w; };
        if (tf) { c.ball = tf[1].toLowerCase() as Ball; note = `从这里起玩家是${BALL_NAME[c.ball]}`; }
        else if (t.type === 'P_Modul_18' && ball !== 'paper') warn(`玩家到这里是${BALL_NAME[ball]}，风扇吹不动它（只有纸球能被吹起来）。要靠风扇过去，前面得先有纸球变球器；之前如果放了别的变球器把球换掉了，挪到风扇区之后`);
        else if (t.type === 'P_Modul_29' && ball === 'stone') warn('玩家到这里是石球，会把软木桥压断，过不去。过桥之前要先变成木球或纸球');
        else if ((t.type === 'P_Box' || t.type === 'P_Modul_01') && ball === 'paper') warn(`玩家到这里是纸球，撞不动${t.label}。如果它挡在必经的路上，前面要先变成石球（木球也比较吃力）`);
        const cells = anchorRects(o).map((q) => ({ x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2, top: q.top }));
        const proj = (q: { x: number; y: number }) => q.x * DX[c.dir] + q.y * DY[c.dir], lat = (q: { x: number; y: number }) => -q.x * DY[c.dir] + q.y * DX[c.dir];
        const lift = t.prop ? DEFAULT_SETTINGS.propLift : 0;
        if (!t.split?.length || cells.length < 2) {
          // 放在路上：默认在刚铺的路的最后一格中间，back 是从光标往回退多少，side 是往左偏多少（负数往右）
          const back = num(s, 'back', 2.5), side = num(s, 'side', 0);
          const tx = c.x - DX[c.dir] * back - DY[c.dir] * side, ty = c.y - DY[c.dir] * back + DX[c.dir] * side;
          if (cells[0]) translateElem(o, [tx - cells[0].x, ty - cells[0].y, c.z - cells[0].top + lift]);
          else translateElem(o, [tx, ty, c.z]);
          if (!prevRoad) note = '它前面这一步不是路面，确认它脚下有路';
        } else {
          // 架在两段路之间的机关：近的那格是刚铺的路的最后一格，远的那格前面补一格路，中间空着
          if (cells.some((q) => Math.abs(lat(q) - lat(cells[0])) > 0.6)) throw (delete doc.elems[o.id], new PathError(`${t.label} 的几个对准方块不在一条直线上，没法顺着赛道自动放：用 add_objects 放，再按结果里的 cells 修路`));
          if (!prevRoad) throw (delete doc.elems[o.id], new PathError(`${t.label} 要架在路的尽头：它前面那一步要是路面`));
          const near = cells.reduce((p, q) => (proj(q) < proj(p) ? q : p)), far = cells.reduce((p, q) => (proj(q) > proj(p) ? q : p));
          translateElem(o, [c.x - DX[c.dir] * 2.5 - near.x, c.y - DY[c.dir] * 2.5 - near.y, c.z - near.top]);
          const span = proj(far) - proj(near), dz = far.top - near.top;
          fwd(span - 5); c.z = r3(c.z + dz); total += span;
          // 远的那一格底下垫一格路
          ids.push(road(5, 5, c.style === 'ribbon' ? 'normal' : c.style).id);
          note = `架在两段路之间（跨 ${r3(span)}），中间空着；后面从它另一头的那格路接着铺`;
        }
      } else if (kind === 'asset') {
        const inf = assetInfo(String(s.name));
        if (!inf || inf.sky) throw new PathError(`不认识的 name「${String(s.name)}」`);
        // 只有「原点在一头、沿一根轴伸出去、左右对称」的木制件能顺着赛道放
        const ax = inf.tile?.axis ?? (inf.max[0] - inf.min[0] >= inf.max[1] - inf.min[1] ? 0 : 1), ot = 1 - ax;
        const atEnd = Math.abs(inf.min[ax]) < 0.6 || Math.abs(inf.max[ax]) < 0.6;
        if (!atEnd || Math.abs(inf.min[ot] + inf.max[ot]) > 0.6) throw new PathError(`${inf.label} 不是从原点沿一个方向伸出去的对称模型，没法顺着赛道自动放：用 add_assets 按原点放`);
        const sign = Math.abs(inf.min[ax]) < 0.6 ? 1 : -1, base = inf.max[ax] - inf.min[ax];
        // 模型本地的伸出方向（轴 ax 的 sign 方向）转到前进方向要转几个 90°
        const local = (ax === 0 ? (sign > 0 ? 0 : 2) : sign > 0 ? 1 : 3);
        const e = add<AssetElem>({ kind: 'asset', name: inf.name, x: c.x, y: c.y, z: c.z, rot: ((c.dir - local + 4) % 4) as Dir });
        let len = base;
        if (s.length !== undefined) {
          if (!inf.stretch) throw (delete doc.elems[e.id], new PathError(`${inf.label} 不能改长度（原长 ${r3(base)}）`));
          len = pos(s, 'length');
          // 有花纹周期的取整个周期，这样末端和开头一样高
          if (inf.tile) len = Math.max(1, Math.round(len / inf.tile.period)) * inf.tile.period;
          const sc: [number, number] = [1, 1];
          sc[ax] = Math.round((len / base) * 1e6) / 1e6;
          if (sc[ax] !== 1) e.scale = sc;
        }
        ids.push(e.id);
        const rise = inf.tile?.dz ? (inf.tile.dz * len) / inf.tile.period : 0;
        fwd(len); c.z = r3(c.z + rise); total += len; prevRoad = null;
        note = `${inf.label}，长 ${r3(len)}${rise ? `，末端${rise > 0 ? '升高' : '降低'} ${r3(Math.abs(rise))}` : ''}。后面接路之前确认高度对得上`;
      } else if (kind === 'guard') {
        if (!prevRoad) throw new PathError('护栏要紧跟在一段路面后面：它装在那段路的边上');
        const b: Box = prevRoad, side = s.side ?? 'both';
        if (side !== 'left' && side !== 'right' && side !== 'both') throw new PathError('side 要是 left / right / both');
        const loops = solve(doc).loops, mx = b.x + b.sx / 2, my = b.y + b.sy / 2, half = (c.dir % 2 === 0 ? b.sy : b.sx) / 2;
        for (const k of side === 'both' ? [1, -1] : [side === 'left' ? 1 : -1]) {
          const r = edgeAt(loops, [mx - DY[c.dir] * half * k, my + DX[c.dir] * half * k, b.z + (b.slope ? b.slope.dz / 2 : 0)], 1.5);
          if (!r) { note = '有一侧没找到路的外沿（可能贴着别的路），没放'; continue; }
          ids.push(add<Extract<Elem, { kind: 'guard' }>>({ kind: 'guard', pts: r.pts.map((q) => [...q] as [number, number, number]), outs: r.outs.map((q) => [...q] as [number, number]), x: r.pts[0][0], y: r.pts[0][1], z: r.pts[0][2] }).id);
        }
      } else throw new PathError(`不认识的步骤「${kind}」：可用 start / road / platform / turn / checkpoint / balloon / rail / rail_turn / spiral / gap / object / asset / guard / mark / goto / connect`);
    } catch (err) {
      if (!(err instanceof PathError)) throw err;
      // 这一步没做成：前面的留着，告诉模型停在了哪
      error = `第 ${i + 1 + offset} 步（${kind}）没做成：${err.message}。前 ${i + offset} 步已经铺好，光标停在这一步之前`;
      if (rail) { try { endRail(); } catch { rail = null; } }
      break;
    }
    for (const id of ids) if (!changed.includes(id)) changed.push(id);
    out.push({ step: i + 1 + offset, do: kind, ids, ...(note ? { note } : {}) });
  }
  // 新铺的路有没有撞上别的路（绕回来压在自己前面铺的路上、或者压到别的路）
  const collisions: string[] = [];
  const mine = changed.map((id) => doc.elems[id]).filter((e): e is Box => !!e && e.kind === 'box' && !e.ang && !e.q);
  const zr = (e: Box): [number, number] => { const dz = e.slope?.dz ?? 0; return [Math.min(e.z, e.z + dz), Math.max(e.z, e.z + dz)]; };
  for (const b of mine) for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'box' || e.id === b.id || e.ang || e.q || (changed.includes(e.id) && e.id > b.id)) continue;
    const ox = Math.min(b.x + b.sx, e.x + e.sx) - Math.max(b.x, e.x), oy = Math.min(b.y + b.sy, e.y + e.sy) - Math.max(b.y, e.y);
    const [b0, b1] = zr(b), [e0, e1] = zr(e);
    if (ox > 1 && oy > 1 && ox * oy > 4 && b0 < e1 + 6 && e0 < b1 + 6) collisions.push(`#${b.id} 和 #${e.id} 叠在一起（重叠 ${Math.round(ox * oy)}${Math.abs(b.z - e.z) > 0.05 ? `，高度只差 ${r3(Math.abs(b.z - e.z))}` : ''}）`);
  }
  // TypeScript 不知道 prevRoad 在上面的闭包里被改过
  const pr = prevRoad as Box | null;
  c.prev = pr ? pr.id : undefined;
  last.set(doc, { ...c });
  return { steps: out, cursor: { ...c }, changed, length: r3(total), ...(error ? { error } : {}), ...(collisions.length ? { collisions: collisions.slice(0, 8) } : {}), ...(logic.length ? { logic } : {}) };
}
