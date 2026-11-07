// 历史地图：每张地图一条记录，内容是压缩后的地图码（比 JSON 小得多），存在浏览器的 localStorage 里。
const KEY = 'bvm.box.maps';
/** 最多留多少张，多了丢最久没动过的 */
const MAX_MAPS = 100;

export interface MapEntry { id: string; name: string; code: string; count: number; updated: number }
export type MapStore = Pick<Storage, 'getItem' | 'setItem'>;

export const newMapId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function listMaps(store: MapStore): MapEntry[] {
  try { return (JSON.parse(store.getItem(KEY) ?? '[]') as MapEntry[]).sort((a, b) => b.updated - a.updated); } catch { return []; }
}

function write(store: MapStore, maps: MapEntry[]) {
  try { store.setItem(KEY, JSON.stringify(maps)); return true; } catch { return false; }
}

/** 存一张地图；内容和名字都没变就不动（不刷新时间）。存满了返回 false */
export function putMap(store: MapStore, e: MapEntry): boolean {
  const maps = listMaps(store);
  const i = maps.findIndex((m) => m.id === e.id);
  if (i >= 0 && maps[i].code === e.code && maps[i].name === e.name) return true;
  if (i >= 0) maps.splice(i, 1);
  return write(store, [e, ...maps].slice(0, MAX_MAPS));
}

export function renameMap(store: MapStore, id: string, name: string) {
  write(store, listMaps(store).map((m) => (m.id === id ? { ...m, name } : m)));
}

export function removeMap(store: MapStore, id: string) {
  write(store, listMaps(store).filter((m) => m.id !== id));
}
