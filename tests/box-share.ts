// 分享链接的编解码：每种元素、每个可选字段都要原样回来；链接里只能有 URL 安全的字符。
import { SCENES } from '../src/box/scenes';
import { listMaps, putMap, removeMap, renameMap } from '../src/box/maps';
import { decodeShare, encodeShare } from '../src/box/share';
import { SHARE_IDS } from '../src/box/share-ids';
import { ASSET_INFO } from '../src/box/asset-info';
import { OBJ_TYPES } from '../src/model/objects';
import type { Doc, Elem } from '../src/box/types';

const fs = (await import('node:fs' as string)) as { readFileSync(p: URL, enc: string): string };
const frozen = (name: string) => JSON.parse(fs.readFileSync(new URL(`./box/${name}`, import.meta.url), 'utf8'));

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void | Promise<void>) => void;

const canon = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** 所有种类的元素，可选字段都填上 */
function everything(): Doc {
  const q: [number, number, number, number] = [0.1305261922, 0, 0, 0.9914448614];
  const es: Elem[] = [
    { id: 1, kind: 'box', x: 0, y: -2.5, z: 1.25, sx: 15, sy: 5, depth: 7.5, style: 'sink', slope: { axis: 1, dz: -2.5 }, open: 5, closed: 2, ang: 30, q, group: 3 },
    { id: 2, kind: 'box', x: 1 / 3, y: 0.1234567, z: 0, sx: 5, sy: 5, depth: 5, style: 'ribbon' },
    { id: 4, kind: 'piece', type: 'check', x: 3, y: 4, z: 5, rot: 2, sector: 3, spawn: 45, ang: 15, group: 3 },
    { id: 5, kind: 'piece', type: 'ramp', x: 3, y: 4, z: 5, rot: 1, inner: 'sink' },
    { id: 7, kind: 'obj', type: 'P_Modul_17', x: -1, y: 2, z: 3, rot: 3, noStopper: true, noBase: true, sector: 2, q },
    { id: 8, kind: 'rail', x: 1, y: 2, z: 3, heading: 90, pieces: [{ kind: 'double', len: 20, radius: 0, angle: 0, dz: 1.5 }], side: { dir: -1, stone: true, ends: [true, false] }, group: 9 },
    { id: 9, kind: 'rail', x: 1, y: 2, z: 3, heading: 0, pieces: [{ kind: 'mono', len: 0, radius: 5, angle: 720, dz: 7.2 }, { kind: 'transition', len: 3, radius: 0, angle: 0, dz: 0 }], sideSpiral: true },
    { id: 11, kind: 'guard', x: 0, y: 0, z: 0, pts: [[0, 0, 0], [5, 0, 0.5], [5, 5, 1]], outs: [[0, -1], [1, 0]], group: 2 },
    { id: 12, kind: 'asset', name: 'WoodPlate', x: 1, y: 1, z: 1, rot: 1, scale: [2, 1.5], ang: 45 },
    { id: 13, kind: 'zone', x: -100, y: -100, z: -20, sx: 200, sy: 200, depth: 10, ang: 10, q },
  ];
  const d: Doc = { elems: {}, nextId: 20, name: '测试地图', settings: { guardTop: 3 } };
  for (const e of es) d.elems[e.id] = e;
  return d;
}

export function boxShareScenarios(check: Check, scenario: Scenario) {
  scenario('历史地图：存取、去重、改名、删除', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const e = (id: string, code: string, updated: number) => ({ id, name: '', code, count: 1, updated });
    putMap(store, e('a', 'x', 1));
    putMap(store, e('b', 'y', 2));
    check(listMaps(store).map((x) => x.id).join() === 'b,a', '最近改的排前面');
    putMap(store, e('a', 'x', 3));
    check(listMaps(store)[0].id === 'b', '内容没变不刷新时间');
    putMap(store, e('a', 'z', 4));
    check(listMaps(store)[0].id === 'a' && listMaps(store).length === 2, '内容变了更新原来那条');
    renameMap(store, 'a', '新名字');
    check(listMaps(store).find((x) => x.id === 'a')!.name === '新名字', '改名');
    removeMap(store, 'a');
    check(listMaps(store).length === 1, '删除');
    for (let i = 0; i < 120; i++) putMap(store, e(`n${i}`, 'c', 10 + i));
    check(listMaps(store).length === 100 && listMaps(store)[0].id === 'n119', '最多留 100 张，丢最久没动过的');
  });

  scenario('地图码编号表：只能往后加，新东西都要有编号', () => {
    const ids = frozen('share-ids.json') as string[];
    check(ids.every((s, i) => SHARE_IDS[i] === s), '编号表不能删、不能改顺序：已经用过的编号在 tests/box/share-ids.json');
    check(SHARE_IDS.length === ids.length, '编号表加了新项：把它们也追加到 tests/box/share-ids.json 末尾');
    check(new Set(SHARE_IDS).size === SHARE_IDS.length, '编号表不能有重复');
    for (const n of [...OBJ_TYPES.map((t) => t.type), ...ASSET_INFO.map((a) => a.name)]) check(SHARE_IDS.includes(n), `${n} 没有编号：加到 src/box/share-ids.ts 末尾`);
  });

  scenario('地图码：历史版本的地图码一直能解开', async () => {
    for (const { label, code, doc } of frozen('share-codes.json') as { label: string; code: string; doc: Doc }[]) {
      check(same(await decodeShare(code), doc), `${label} 解出来和当时不一样`);
    }
  });

  scenario('分享链接：所有元素、可选字段原样回来', async () => {
    const d = everything();
    const text = await encodeShare(d);
    check(/^[A-Za-z0-9_-]+$/.test(text), '只能有 URL 安全的字符');
    check(same(await decodeShare(text), d), '解码后应和原来完全一样');
    check((await decodeShare(text)).nextId === 20, 'nextId 要保留');
    check((await decodeShare(text)).name === '测试地图', '名字要保留');
  });

  scenario('分享链接：内置场景都走紧凑二进制，比 JSON 短', async () => {
    for (const s of SCENES) {
      const d = s.build();
      const text = await encodeShare(d);
      check(same(await decodeShare(text), d), `${s.name} 解码后应一样`);
      check(atob(text.replace(/-/g, '+').replace(/_/g, '/').slice(0, 4)).charCodeAt(0) === 1, `${s.name} 应走二进制`);
      check(text.length < JSON.stringify(d).length / 2, `${s.name} 应小于 JSON 的一半：${text.length}`);
    }
  });

  scenario('分享链接：二进制表示不了的字段自动退回 JSON，不丢数据', async () => {
    const d = everything();
    (d.elems[1] as unknown as Record<string, unknown>).future = { a: 1 };
    const back = await decodeShare(await encodeShare(d));
    check(same(back, d), '新字段不能丢');
  });

  scenario('分享链接：坏数据要报错，不能打开半张图', async () => {
    const text = await encodeShare(everything());
    for (const bad of [text.slice(0, text.length >> 1), 'AAAA', '!!!']) {
      let threw = false;
      try { await decodeShare(bad); } catch { threw = true; }
      check(threw, `应该报错：${bad.slice(0, 12)}`);
    }
  });
}
