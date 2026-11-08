// 帮助教程的实时演示检查：无头 Edge 把每段演示（src/box/demos.ts）完整跑一轮，报告有没有出错、一轮多长，顺便截一张中途的画面。
// 改了交互方式、界面之后跑一下，看哪段演示坏了。
//
// 用法：node scripts/help/check-demos.mjs [只查这些名字…] [--url http://127.0.0.1:5173/] [--shots 目录] [--jobs 4]
// 依赖：Edge（EDGE 环境变量可以指定路径）；先 npm run dev 开着开发服务器。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const URL_ = opt('url') ?? 'http://127.0.0.1:5173/';
const SHOTS = opt('shots');
const JOBS = Number(opt('jobs') ?? 4);
const EDGE = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const W = 800, H = 450;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// 演示的名字直接从 demos.ts 里读（name: '...'），不用另外维护一份列表
const all = [...readFileSync(join(ROOT, 'src/box/demos.ts'), 'utf8').matchAll(/^\s+name: '([\w-]+)'/gm)].map((m) => m[1]);
const only = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const names = only.length ? all.filter((n) => only.includes(n)) : all;

/** 开一个无头浏览器，依次检查一组演示 */
async function worker(list) {
  const prof = mkdtempSync(join(tmpdir(), 'bvm-demo-prof-'));
  const port = 9800 + Math.floor(Math.random() * 150);
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 100 && !ws; i++) {
    try { const p = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  let errors = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const out = [];
  for (const name of list) {
    errors = [];
    await send('Page.navigate', { url: `${URL_}?demo=${name}&theme=light` });
    const t0 = Date.now();
    let st = null, shot = false, loopStart = 0;
    while (Date.now() - t0 < 40000) {
      await sleep(250);
      st = await js('window.__demo && JSON.stringify(window.__demo)').then((v) => (v ? JSON.parse(v) : null)).catch(() => null);
      if (!st) continue;
      if (!loopStart) loopStart = Date.now();
      // 一轮里大约中间的时候截一张图
      if (SHOTS && !shot && Date.now() - loopStart > 3500) {
        const { result } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(result.data, 'base64'));
        shot = true;
      }
      if (st.error || st.loops >= 1) break;
    }
    const sec = loopStart ? ((Date.now() - loopStart) / 1000).toFixed(1) : '-';
    const err = st?.error || (errors.length ? errors[0].split('\n')[0] : '') || (st ? (st.loops >= 1 ? '' : '超时，一轮没跑完') : '演示没有启动');
    out.push({ name, ok: !err, sec, err });
    console.log(`${err ? '✗' : '✓'} ${name}：${err ? err : `一轮约 ${sec} 秒`}`);
  }
  ws.close(); proc.kill();
  await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
  try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 浏览器还占着就留给系统清理 */ }
  return out;
}

const batches = Array.from({ length: Math.min(JOBS, names.length) }, (_, k) => names.filter((_, i) => i % JOBS === k));
const res = (await Promise.all(batches.map(worker))).flat();
const bad = res.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 段演示有问题：${bad.map((r) => r.name).join(' ')}` : `\n全部 ${res.length} 段演示正常`);
process.exit(bad.length ? 1 : 0);
