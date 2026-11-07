// 地图码：把地图压成一串文字，用来分享，历史地图也这样存。
//
// 格式：第一个字节是模式，后面是 deflate-raw 压缩的内容，整体转成 base64url（不带 =）。
//   模式 1：紧凑二进制。元素按种类分开、按列存（同一个字段连着放），坐标转成千分之一的整数、相邻元素只存差值。
//   模式 2：JSON。编码完会解码核对，有二进制表示不了的字段（比如新加了字段忘了写进 SPECS）时自动退到这里。
// 改了 SPECS 的字段顺序或含义要换一个新的模式号，并保留旧的解码，不然旧的地图码打不开。
// tests/box/share-codes.json 留着各个版本的地图码，测试保证它们一直能解开。
import { SHARE_IDS } from './share-ids';
import type { Doc, Elem } from './types';

const MODE_BIN = 1, MODE_JSON = 2;
const ID_OF = new Map(SHARE_IDS.map((s, i) => [s, i]));

class Writer {
  bytes: number[] = [];
  strings: string[] = [];
  /** 无符号变长整数 */
  uint(v: number) {
    while (v >= 128) { this.bytes.push((v % 128) | 128); v = Math.floor(v / 128); }
    this.bytes.push(v);
  }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    this.bytes.push(...b);
  }
  /** 数字：千分之一的整数存得下就存整数（相对 prev 的差），存不下存原始的 64 位浮点 */
  num(v: number, prev = 0): number {
    const q = Math.round(v * 1000);
    if (Math.abs(q / 1000 - v) > 1e-9 || Math.abs(q) > 2 ** 45) { this.uint(1); this.f64(v); return prev; }
    const d = q - prev;
    this.uint((d < 0 ? -d * 2 - 1 : d * 2) * 2);
    return q;
  }
  /** 文字：编号表里有的存编号（偶数），没有的（地图名字等）放进这张图自己的字符串表（奇数） */
  str(s: string) {
    const id = ID_OF.get(s);
    if (id !== undefined) { this.uint(id * 2); return; }
    let i = this.strings.indexOf(s);
    if (i < 0) { i = this.strings.length; this.strings.push(s); }
    this.uint(i * 2 + 1);
  }
}

class Reader {
  pos = 0;
  strings: string[] = [];
  constructor(public bytes: Uint8Array) {}
  uint(): number {
    let v = 0, m = 1;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error('数据不完整');
      const b = this.bytes[this.pos++];
      v += (b & 127) * m;
      if (b < 128) return v;
      m *= 128;
    }
  }
  f64(): number {
    if (this.pos + 8 > this.bytes.length) throw new Error('数据不完整');
    const v = new Float64Array(this.bytes.slice(this.pos, this.pos + 8).buffer)[0];
    this.pos += 8;
    return v;
  }
  /** 返回 [值, 下一个 prev] */
  num(prev = 0): [number, number] {
    const t = this.uint();
    if (t === 1) return [this.f64(), prev];
    const z = t / 2, q = prev + (z % 2 ? -(z + 1) / 2 : z / 2);
    return [q / 1000, q];
  }
  str(): string {
    const v = this.uint(), i = Math.floor(v / 2);
    const s = v % 2 ? this.strings[i] : SHARE_IDS[i];
    if (s === undefined) throw new Error('数据不完整');
    return s;
  }
}

/** 一个字段怎么存 */
interface Codec<T = unknown> { w(o: Writer, v: T): void; r(i: Reader): T }
const num: Codec<number> = { w: (o, v) => { o.num(v); }, r: (i) => i.num()[0] };
const uint: Codec<number> = { w: (o, v) => o.uint(v), r: (i) => i.uint() };
const str: Codec<string> = { w: (o, v) => o.str(v), r: (i) => i.str() };
const flag: Codec<boolean> = { w: () => {}, r: () => true };
const list = <T>(c: Codec<T>): Codec<T[]> => ({ w: (o, v) => { o.uint(v.length); for (const x of v) c.w(o, x); }, r: (i) => Array.from({ length: i.uint() }, () => c.r(i)) });
const tuple = <T>(c: Codec<T>, n: number): Codec<T[]> => ({ w: (o, v) => { for (const x of v) c.w(o, x); }, r: (i) => Array.from({ length: n }, () => c.r(i)) });
/** 固定字段的小对象；带 ? 的字段可以没有 */
function record(fields: [string, Codec<never>][]): Codec<Record<string, unknown>> {
  const names = fields.map(([k]) => k.replace('?', ''));
  return {
    w(o, v) {
      let mask = 0;
      fields.forEach(([k], n) => { if (k.endsWith('?') && v[names[n]] !== undefined) mask |= 1 << n; });
      o.uint(mask);
      fields.forEach(([k, c], n) => { if (!k.endsWith('?') || mask & (1 << n)) (c as Codec).w(o, v[names[n]]); });
    },
    r(i) {
      const mask = i.uint(), v: Record<string, unknown> = {};
      fields.forEach(([k, c], n) => { if (!k.endsWith('?') || mask & (1 << n)) v[names[n]] = (c as Codec).r(i); });
      return v;
    },
  };
}
const F = <T>(k: string, c: Codec<T>): [string, Codec<never>] => [k, c as unknown as Codec<never>];

const slope = record([F('axis', uint), F('dz', num)]);
const railPiece = record([F('kind', str), F('len', num), F('radius', num), F('angle', num), F('dz', num)]);
const bools = list<boolean>({ w: (o, v) => o.uint(v ? 1 : 0), r: (i) => i.uint() === 1 });
const sideRail = record([F('dir', num), F('stone?', flag), F('ends?', bools)]);

/** 字段：'名字'（必有）、'名字?'（可以没有）。x、y、z 单独按差值存，不写在这里 */
const COMMON: [string, Codec<never>][] = [F('ang?', num), F('q?', tuple(num, 4)), F('group?', uint)];
const SPECS: Record<Elem['kind'], [string, Codec<never>][]> = {
  box: [F('sx', num), F('sy', num), F('depth', num), F('style', str), F('slope?', slope), F('open?', uint), F('closed?', uint), ...COMMON],
  piece: [F('type', str), F('rot', uint), F('inner?', str), F('sector?', uint), F('spawn?', num), ...COMMON],
  obj: [F('type', str), F('rot', uint), F('noStopper?', flag), F('noBase?', flag), F('sector?', uint), ...COMMON],
  rail: [F('heading', num), F('pieces', list(railPiece)), F('side?', sideRail), F('sideSpiral?', flag), F('group?', uint)],
  guard: [F('pts', list(tuple(num, 3))), F('outs', list(tuple(num, 2))), F('group?', uint)],
  asset: [F('name', str), F('rot', uint), F('scale?', tuple(num, 2)), ...COMMON],
  zone: [F('sx', num), F('sy', num), F('depth', num), ...COMMON],
};
const KINDS = Object.keys(SPECS) as Elem['kind'][];
const F2 = <T>(kind: Elem['kind'], name: string, c: Codec<T>): [Elem['kind'], string, Codec<never>] => [kind, name, c as unknown as Codec<never>];
/**
 * 后来加的可选字段：SPECS 是按列存的，往里插一列旧地图码就全错位了，所以新字段一律排在所有元素后面，只能往这里追加。
 * 旧地图码读到这里数据就结束了，这些字段就是没有。
 */
const EXTRAS: [Elem['kind'], string, Codec<never>][] = [F2('rail', 'tips', bools), F2('rail', 'q', tuple(num, 4))];

/** 可选的一列：先写哪些元素有（大多数地图整列都没有，一个 0 就结束），再写它们的值 */
function writeColumn(o: Writer, es: Record<string, never>[], name: string, c: Codec) {
  const has = es.filter((e) => e[name] !== undefined);
  o.uint(has.length);
  let at = 0;
  es.forEach((e, n) => { if (e[name] !== undefined) { o.uint(n - at); at = n; } });
  for (const e of has) c.w(o, e[name]);
}
function readColumn(i: Reader, es: Record<string, unknown>[], name: string, c: Codec) {
  const m = i.uint(), at: number[] = [];
  let a = 0;
  for (let k = 0; k < m; k++) { a += i.uint(); at.push(a); }
  for (const idx of at) { if (!es[idx]) throw new Error('数据不完整'); es[idx][name] = c.r(i); }
}

function encodeBin(doc: Doc): Uint8Array {
  const o = new Writer();
  o.uint(doc.nextId);
  o.str(doc.settings ? JSON.stringify(doc.settings) : '');
  o.str(doc.name ?? '');
  const ofKind = (kind: Elem['kind']) => (Object.values(doc.elems) as Elem[]).filter((e) => e.kind === kind).sort((a, b) => a.id - b.id) as unknown as Record<string, never>[];
  for (const kind of KINDS) {
    const es = ofKind(kind);
    o.uint(es.length);
    let id = 0;
    for (const e of es) { o.uint((e.id as number) - id); id = e.id; }
    for (const k of ['x', 'y', 'z']) { let p = 0; for (const e of es) p = o.num(e[k], p); }
    SPECS[kind].forEach(([key, c]) => {
      const name = key.replace('?', ''), opt = key.endsWith('?');
      if (opt) writeColumn(o, es, name, c as Codec);
      else for (const e of es) (c as Codec).w(o, e[name]);
    });
  }
  for (const [kind, name, c] of EXTRAS) writeColumn(o, ofKind(kind), name, c as Codec);
  // 字符串表放最前面
  const head = new Writer();
  head.uint(o.strings.length);
  const enc = new TextEncoder();
  for (const s of o.strings) { const b = enc.encode(s); head.uint(b.length); head.bytes.push(...b); }
  return new Uint8Array([...head.bytes, ...o.bytes]);
}

function decodeBin(bytes: Uint8Array): Doc {
  const i = new Reader(bytes);
  const dec = new TextDecoder();
  const n = i.uint();
  for (let k = 0; k < n; k++) { const len = i.uint(); i.strings.push(dec.decode(bytes.slice(i.pos, i.pos + len))); i.pos += len; }
  const doc: Doc = { elems: {}, nextId: i.uint() };
  const settings = i.str();
  if (settings) doc.settings = JSON.parse(settings);
  const name = i.str();
  if (name) doc.name = name;
  const byKind = new Map<Elem['kind'], Record<string, unknown>[]>();
  for (const kind of KINDS) {
    const count = i.uint();
    const es: Record<string, unknown>[] = [];
    byKind.set(kind, es);
    let id = 0;
    for (let k = 0; k < count; k++) { id += i.uint(); es.push({ id, kind }); }
    for (const key of ['x', 'y', 'z']) { let p = 0; for (const e of es) { const [v, q] = i.num(p); e[key] = v; p = q; } }
    SPECS[kind].forEach(([key, c]) => {
      const name = key.replace('?', '');
      if (key.endsWith('?')) readColumn(i, es, name, c as Codec);
      else for (const e of es) e[name] = (c as Codec).r(i);
    });
    for (const e of es) doc.elems[e.id as number] = e as unknown as Elem;
  }
  for (const [kind, name, c] of EXTRAS) {
    if (i.pos >= bytes.length) break; // 旧地图码到这里就结束了
    readColumn(i, byKind.get(kind)!, name, c as Codec);
  }
  return doc;
}

/** 字段顺序不同也算一样；值是 undefined 的字段不算；0.1 + 0.2 这种浮点尾数的差别也不算 */
function canon(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 + 0;
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function pipe(data: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  w.write(data).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** 地图 → 地图码 */
export async function encodeShare(doc: Doc): Promise<string> {
  let mode = MODE_BIN, body: Uint8Array;
  try {
    body = encodeBin(doc);
    if (!same(decodeBin(body), JSON.parse(JSON.stringify(doc)))) throw new Error('二进制表示不了');
  } catch {
    mode = MODE_JSON;
    body = new TextEncoder().encode(JSON.stringify(doc));
  }
  const packed = await pipe(body, new CompressionStream('deflate-raw'));
  return toB64(new Uint8Array([mode, ...packed]));
}

/** 地图码 → 地图；格式不对时抛错 */
export async function decodeShare(text: string): Promise<Doc> {
  const raw = fromB64(text);
  const body = await pipe(raw.slice(1), new DecompressionStream('deflate-raw'));
  const doc = raw[0] === MODE_BIN ? decodeBin(body) : raw[0] === MODE_JSON ? JSON.parse(new TextDecoder().decode(body)) as Doc : null;
  if (!doc || typeof doc.elems !== 'object' || !doc.elems) throw new Error('不认识的地图码');
  return doc;
}
