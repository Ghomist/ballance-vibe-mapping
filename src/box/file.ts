// 地图文件（.bvm）：一个 JSON 文本，里面放着地图名和地图码。
// 地图本体用地图码（share.ts）存，旧版本的兼容都在那边处理；外面这层 JSON 只是为了能一眼看出是什么文件、哪个版本存的。
import { decodeShare, encodeShare } from './share';
import type { Doc } from './types';

export const BVM_EXT = '.bvm';
const FORMAT = 'bvm-map';
const VERSION = 1;

export async function encodeBvm(doc: Doc): Promise<string> {
  return JSON.stringify({ format: FORMAT, version: VERSION, name: doc.name ?? '', elements: Object.keys(doc.elems).length, saved: new Date().toISOString(), code: await encodeShare(doc) }, null, 1);
}

/** 读地图文件；打不开时抛错，message 是能直接给用户看的原因 */
export async function decodeBvm(text: string): Promise<Doc> {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) throw new Error('文件是空的');
  let code = t;
  if (t.startsWith('{')) {
    let j: { format?: unknown; version?: unknown; code?: unknown; name?: unknown };
    try { j = JSON.parse(t); } catch { throw new Error('文件内容不完整或者被改坏了'); }
    if (j.format !== FORMAT) throw new Error('这不是 BVM 的地图文件');
    if (typeof j.version === 'number' && j.version > VERSION) throw new Error('这个文件是更新版本的 BVM 存的，请刷新页面用最新版打开');
    if (typeof j.code !== 'string' || !j.code) throw new Error('文件里没有地图数据');
    code = j.code;
  }
  // 不是 JSON 的：当成直接存了一串地图码的文本文件
  let doc: Doc;
  try { doc = await decodeShare(code.replace(/\s+/g, '')); } catch { throw new Error('地图数据解不开，文件可能不完整'); }
  if (!doc.elems || typeof doc.elems !== 'object' || typeof doc.nextId !== 'number') throw new Error('地图数据不完整');
  return doc;
}
