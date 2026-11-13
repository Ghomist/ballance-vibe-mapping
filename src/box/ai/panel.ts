// AI 制图面板（实验功能）：一个对话区。用户填好自己的 API Key，用自然语言说想要什么，模型通过工具（tools.ts）一步一步改地图，
// 每一步都显示在对话里、同时在视图里高亮；用户可以随时喊停、撤销这一轮、接着提修改意见。
// 面板只管界面和对话，地图怎么改都走 AgentHost（由 app.ts 提供）。
import type { Doc } from '../types';
import { runTurn, systemPrompt, trimHistory } from './agent';
import { type ChatMsg, PROVIDERS, makeLlm } from './llm';
import { MUTATING, type ToolOut, runTool } from './tools';
import { splitPathCall } from './path';

export interface AgentHost {
  /** 当前的地图（整张；在孤立模式里会先退出） */
  doc(): Doc;
  /** 现在不方便让 AI 动地图的原因（正在拖动等），没有就是 null */
  busy(): string | null;
  /** 一轮里第一次要改地图之前调用：存一步撤销（这一轮的改动算一步） */
  beginEdit(): void;
  /** 这一轮结果什么都没改：把刚才存的那步撤销拿掉 */
  cancelEdit(): void;
  /** 地图改了：重建画面，选中这些元素；follow 时把视角移过去 */
  refresh(changed: number[], follow: boolean): void;
  /** 选中并对准这些元素 */
  focus(ids: number[]): void;
  selection(): number[];
  /** 撤销栈有多深（用来判断「撤销这一轮」还能不能用）、撤销一步 */
  undoDepth(): number;
  undo(): void;
  flash(text: string, warn?: boolean): void;
  /** 面板开关了：布局变了 */
  layout(open: boolean): void;
}

interface Config { provider: string; base: string; model: string; key: string; follow: boolean }
const STORE = 'bvm.ai';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 模型说的话：转义后只认换行、**加粗** 和 `代码` */
const rich = (s: string) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

const EXAMPLES = [
  '做一个简单的入门关：起点出发，一段直路，一个右转弯，中间一个小节盘点，最后到终点飞船。别忘了云层和死亡区。',
  '在选中的这段路后面接一段上坡，升高 10，再接一个平台。',
  '检查一下这张图有什么问题，能修的帮我修掉。',
];

export function initAgentPanel(mount: HTMLElement, host: AgentHost) {
  const load = (): Config => {
    const d: Config = { provider: 'deepseek', base: PROVIDERS[0].base, model: PROVIDERS[0].model, key: '', follow: true };
    try { return { ...d, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return d; }
  };
  let cfg = load();
  const saveCfg = () => { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* 存不了就算了 */ } };

  const el = document.createElement('aside');
  el.id = 'agent';
  el.hidden = true;
  el.innerHTML = `
    <div class="ag-head">
      <span class="ag-title">AI 制图<i>实验</i></span>
      <button class="ag-icon" data-a="settings" title="设置：服务商、模型、API Key"><svg viewBox="0 0 16 16"><path d="M2.5 4h4M9.5 4h4M2.5 8h7M12.5 8h1M2.5 12h2M7.5 12h6" /><circle cx="8" cy="4" r="1.5" /><circle cx="11" cy="8" r="1.5" /><circle cx="6" cy="12" r="1.5" /></svg></button>
      <button class="ag-icon" data-a="clear" title="清空对话（地图不动）"><svg viewBox="0 0 16 16"><path d="M3 4.5h10 M6 4.5V3h4v1.5 M4.5 4.5l.7 9h5.6l.7-9" /></svg></button>
      <button class="ag-icon" data-a="close" title="收起面板"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </div>
    <div class="ag-settings" hidden></div>
    <div class="ag-list"></div>
    <div class="ag-compose">
      <textarea rows="2" placeholder="说说想要什么样的关卡，或者让它改哪里…" spellcheck="false"></textarea>
      <div class="ag-bar"><label title="AI 每做一步，视角跟过去看"><input type="checkbox" data-follow> 视角跟随</label><span class="ag-state"></span><button class="primary" data-a="send">发送</button></div>
    </div>`;
  mount.appendChild(el);
  const listEl = el.querySelector<HTMLElement>('.ag-list')!, setEl = el.querySelector<HTMLElement>('.ag-settings')!;
  const input = el.querySelector('textarea')!, sendBtn = el.querySelector<HTMLButtonElement>('[data-a="send"]')!, stateEl = el.querySelector<HTMLElement>('.ag-state')!;
  const followEl = el.querySelector<HTMLInputElement>('[data-follow]')!;
  followEl.checked = cfg.follow;
  followEl.addEventListener('change', () => { cfg.follow = followEl.checked; saveCfg(); });

  /** 发给模型的对话（含系统提示）；界面上的消息另外画 */
  let messages: ChatMsg[] = [];
  let running: AbortController | null = null;
  /** AI 正在等用户回答的问题（ask_user）：这时输入框里发出去的是回答，不是新的一轮 */
  let pending: ((answer: string) => void) | null = null;
  function ask(args: unknown, signal: AbortSignal): Promise<string> {
    const a = (args && typeof args === 'object' ? args : {}) as { question?: unknown; options?: unknown };
    const q = String(a.question ?? '').trim() || '（没有写问题）';
    const opts = (Array.isArray(a.options) ? a.options : []).map(String).filter(Boolean).slice(0, 6);
    const d = addMsg('ask', `<div class="ag-q">${rich(q)}</div>${opts.length ? `<div class="ag-opts">${opts.map((o) => `<button type="button">${esc(o)}</button>`).join('')}</div>` : ''}<small>${opts.length ? '点一个选项，或者在下面输入你的回答' : '在下面输入你的回答'}</small>`);
    return new Promise((resolve) => {
      const done = (ans: string, show = true) => {
        if (!pending) return;
        pending = null;
        signal.removeEventListener('abort', stop);
        d.classList.add('answered');
        d.querySelectorAll('button').forEach((b) => { b.disabled = true; if (b.textContent === ans) b.classList.add('picked'); });
        if (show) addMsg('user', esc(ans).replace(/\n/g, '<br>'));
        syncSend();
        resolve(ans);
      };
      const stop = () => done('（用户中止了，没有回答）', false);
      pending = done;
      signal.addEventListener('abort', stop);
      d.addEventListener('click', (e) => { const b = (e.target as Element).closest('button'); if (b && !b.disabled) done(b.textContent ?? ''); });
      syncSend();
      input.focus();
    });
  }
  /** 发送按钮现在是干什么的：发送 / 停止 / 回答 */
  function syncSend() {
    const answering = !!pending && !!input.value.trim();
    sendBtn.textContent = !running ? '发送' : answering ? '回答' : '停止';
    sendBtn.classList.toggle('danger', !!running && !answering);
    stateEl.textContent = pending ? '等你回答…' : running ? 'AI 正在制图…' : '';
  }
  const ready = () => !!cfg.key.trim() && !!cfg.base.trim() && !!cfg.model.trim();

  const scroll = () => { listEl.scrollTop = listEl.scrollHeight; };
  const addMsg = (cls: string, html: string) => { const d = document.createElement('div'); d.className = `ag-msg ${cls}`; d.innerHTML = html; listEl.appendChild(d); scroll(); return d; };
  function intro() {
    listEl.innerHTML = '';
    addMsg('warn', '<b>实验功能：极其不稳定，效果不佳，仅供娱乐。</b>搭出来的图多半要你自己大改；别拿重要的地图试，先另存一份。');
    addMsg('note', `用自然语言描述想要的关卡，AI 会一步一步在编辑器里搭出来，每一步你都看得到，随时可以喊停、撤销，或者接着说怎么改。${ready() ? '' : '<br><br><b>先点右上角的设置，填上 API Key。</b>'}`);
    const ex = addMsg('examples', `<small>试试这样说</small>${EXAMPLES.map((t) => `<button type="button">${esc(t)}</button>`).join('')}`);
    ex.addEventListener('click', (e) => { const b = (e.target as Element).closest('button'); if (b) { input.value = b.textContent ?? ''; input.focus(); } });
  }

  // ---------------- 设置 ----------------
  function renderSettings() {
    const p = PROVIDERS.find((x) => x.id === cfg.provider) ?? PROVIDERS[PROVIDERS.length - 1];
    setEl.innerHTML = `
      <label>服务商<select data-k="provider">${PROVIDERS.map((x) => `<option value="${x.id}"${x.id === cfg.provider ? ' selected' : ''}>${x.label}</option>`).join('')}</select></label>
      <label>接口地址<input data-k="base" type="text" spellcheck="false" placeholder="https://…/v1" value="${esc(cfg.base)}"></label>
      <label>模型<input data-k="model" type="text" spellcheck="false" placeholder="模型名" value="${esc(cfg.model)}"></label>
      <label>API Key<input data-k="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="${esc(cfg.key)}"></label>
      <p>${p.keyUrl ? `Key 在 <a href="${p.keyUrl}" target="_blank" rel="noopener">${new URL(p.keyUrl).host}</a> 申请。` : '填任何兼容 OpenAI 接口、支持工具调用（function calling）的服务。'}Key 只存在这台电脑的这个浏览器里，请求从浏览器直接发给上面的接口地址，不经过别的服务器；费用按服务商的价格算。不要在别人的电脑上填。</p>
      <div class="ag-row"><button data-a="forget" title="把存着的 Key 删掉">清除 Key</button><button class="primary" data-a="done">完成</button></div>`;
  }
  setEl.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement, k = t.dataset.k as keyof Config | undefined;
    if (!k) return;
    if (k === 'provider') {
      const p = PROVIDERS.find((x) => x.id === t.value)!;
      cfg = { ...cfg, provider: p.id, ...(p.base ? { base: p.base, model: p.model } : {}) };
      renderSettings();
    } else (cfg as unknown as Record<string, string>)[k] = t.value.trim();
    saveCfg();
  });
  const showSettings = (on: boolean) => { if (on) renderSettings(); setEl.hidden = !on; if (!on && !listEl.querySelector('.ag-msg.user')) intro(); };

  // ---------------- 一轮对话 ----------------
  function setRunning(c: AbortController | null) {
    running = c;
    syncSend();
    el.classList.toggle('running', !!c);
  }
  async function send() {
    const text = input.value.trim();
    // AI 在等回答：这一句是回答
    if (pending) { if (text) { input.value = ''; pending(text); } return; }
    if (!text || running) return;
    if (!ready()) { showSettings(true); host.flash('先填上 API Key、接口地址和模型', true); return; }
    const why = host.busy();
    if (why) { host.flash(why, true); return; }
    input.value = '';
    if (!messages.length) { listEl.innerHTML = ''; messages = [{ role: 'system', content: systemPrompt() }]; }
    addMsg('user', esc(text).replace(/\n/g, '<br>'));
    // 每条消息前面带上现状：模型不用猜用户指的是哪些东西
    const sel = host.selection(), n = Object.keys(host.doc().elems).length;
    messages.push({ role: 'user', content: `[地图现在有 ${n} 个元素；用户当前选中的 id：${sel.length ? sel.slice(0, 80).join(', ') : '无'}]\n\n${text}` });
    messages = trimHistory(messages);

    const ctl = new AbortController();
    setRunning(ctl);
    const depth = host.undoDepth();
    let began = false, mutated = false, steps = 0, textEl: HTMLElement | null = null, said = '';
    const touched = new Set<number>();
    const stepEls = new Map<string, HTMLElement>();
    try {
      const end = await runTurn({
        llm: makeLlm(cfg), messages, signal: ctl.signal,
        exec: async (name, args) => {
          const doc = host.doc();
          if (MUTATING.has(name) && !began) { host.beginEdit(); began = true; }
          if (name === 'ask_user') {
            const answer = await ask(args, ctl.signal);
            return { result: { answer }, summary: `问了用户：${answer}`, ok: true };
          }
          let out: ToolOut;
          if (name === 'build_path' && args && typeof args === 'object') {
            // 铺赛道：一步一步铺给人看（每一小步都重建画面），结果合成一份还给模型
            const parts = splitPathCall(args as Record<string, unknown>);
            const steps: unknown[] = [], changed: number[] = [], logic: unknown[] = [], coll: unknown[] = [];
            let res: Record<string, unknown> = {}, len = 0, any = false, summary = '';
            for (const part of parts) {
              if (ctl.signal.aborted) { res = { ...res, error: `用户中止了：前 ${steps.length} 步已经铺好` }; break; }
              const o = runTool(doc, name, part), r = o.result as Record<string, unknown>;
              summary = o.summary;
              if (Array.isArray(r.steps)) steps.push(...r.steps);
              // 每一小次各自报的问题攒起来（后一次的结果会盖掉前一次的）
              if (Array.isArray(r.logic_problems)) logic.push(...r.logic_problems);
              if (Array.isArray(r.collisions)) coll.push(...r.collisions);
              len += Number(r.path_length) || 0;
              res = { ...res, ...r };
              if (o.mutated) { any = true; for (const id of o.changed) changed.push(id); mutated = true; for (const id of o.changed) touched.add(id); host.refresh(o.changed, cfg.follow); await sleep(170); }
              if (r.error) break;
            }
            res = { ...res, steps, path_length: Math.round(len * 100) / 100 };
            if (logic.length) res.logic_problems = logic; else { delete res.logic_problems; delete res.logic_note; }
            if (coll.length) res.collisions = coll; else { delete res.collisions; delete res.collisions_note; }
            const flags = `${logic.length ? `，${logic.length} 处球种说不通` : ''}${coll.length ? `，${coll.length} 处路叠在一起` : ''}`;
            out = { result: res, summary: parts.length > 1 ? (res.error ? `铺赛道：做了 ${steps.length} 步后停下${flags}` : `铺赛道 ${steps.length} 步，长 ${Math.round(len)}${flags}`) : summary, changed, mutated: any };
            if (any) host.refresh(changed, false);
          } else {
            out = runTool(doc, name, args);
            if (out.mutated) {
              mutated = true;
              for (const id of out.changed) touched.add(id);
              host.refresh(out.changed, cfg.follow);
              await sleep(260); // 停一下，让人看清这一步
            }
          }
          if (out.focus) host.focus(out.focus);
          return { result: out.result, summary: out.summary, ok: !(out.result && typeof out.result === 'object' && 'error' in (out.result as object)), ids: out.changed } as { result: unknown; summary: string; ok: boolean };
        },
        on: {
          text: (d) => { said += d; textEl ??= addMsg('ai', ''); textEl.innerHTML = rich(said); scroll(); },
          said: () => { textEl = null; said = ''; },
          toolStart: (call, args) => {
            if (call.name === 'ask_user') return; // 问题自己有一张卡片
            steps++;
            const d = addMsg('step', `<div class="ag-step-head"><i></i><span>${esc(call.name)}…</span></div><details><summary>细节</summary><pre></pre></details>`);
            d.dataset.state = 'run';
            d.querySelector('pre')!.textContent = `参数：${JSON.stringify(args, null, 1)}`;
            stepEls.set(call.id, d);
          },
          toolEnd: (call, r) => {
            const d = stepEls.get(call.id);
            if (!d) return;
            // 一批里有几个没做成（result.errors）：黄色，提醒看一眼细节
            const rr = (r.result && typeof r.result === 'object' ? r.result : {}) as { errors?: unknown; logic_problems?: unknown; collisions?: unknown };
            const partial = Array.isArray(rr.errors) || Array.isArray(rr.logic_problems) || Array.isArray(rr.collisions);
            d.dataset.state = !r.ok ? 'err' : partial ? 'warn' : 'ok';
            d.querySelector('span')!.textContent = r.summary;
            const ids = (r as { ids?: number[] }).ids ?? [];
            if (ids.length) { d.dataset.ids = ids.join(','); d.classList.add('go'); d.title = '点一下：选中并对准这一步改动的东西'; }
            const res = JSON.stringify(r.result, null, 1);
            d.querySelector('pre')!.textContent += `\n\n结果：${res.length > 4000 ? `${res.slice(0, 4000)}…` : res}`;
            scroll();
          },
        },
      });
      if (end === 'aborted') addMsg('note', '已停止。已经做完的步骤保留着，可以撤销这一轮，或者接着说。');
      else if (end === 'max-steps') addMsg('note', '这一轮步骤太多，先停在这里。说「继续」可以接着做。');
    } catch (e) {
      addMsg('err', esc((e as Error).message));
      // 出错的这一轮，没有回复的那条用户消息留着也没关系；但没配对的工具调用会让下一次请求被拒绝，退回到这一轮开始之前
      const last = messages.map((m) => m.role).lastIndexOf('user');
      const tail = messages.slice(last + 1);
      if (tail.some((m) => m.role === 'assistant' && m.tool_calls?.length && !m.tool_calls.every((c) => tail.some((t) => t.role === 'tool' && t.tool_call_id === c.id)))) messages = messages.slice(0, last + 1);
    } finally {
      if (began && !mutated) host.cancelEdit();
      setRunning(null);
      if (mutated) {
        const d = addMsg('turn', `<span>这一轮做了 ${steps} 步，新增 / 改动了 ${touched.size} 个元素</span><button type="button" data-undo="${depth}">撤销这一轮</button>`);
        d.dataset.ids = [...touched].join(',');
      }
    }
  }
  sendBtn.addEventListener('click', () => { if (pending && input.value.trim()) void send(); else if (running) running.abort(); else void send(); });
  input.addEventListener('input', () => { if (pending) syncSend(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 打字不触发编辑器的快捷键
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  listEl.addEventListener('click', (e) => {
    const t = e.target as Element;
    const u = t.closest<HTMLButtonElement>('[data-undo]');
    if (u) {
      if (running) return;
      // 这一轮存的那步撤销还在栈顶才撤：之后又改过的话，撤的就不是这一轮了
      if (host.undoDepth() !== +u.dataset.undo! + 1) { host.flash('这一轮之后地图又改过了：用撤销（Ctrl+Z）一步步退回去', true); return; }
      host.undo();
      u.disabled = true; u.textContent = '已撤销';
      messages.push({ role: 'user', content: '[用户撤销了你上一轮对地图的全部改动，地图回到了那一轮之前的样子。]' }, { role: 'assistant', content: '好的，上一轮的改动已经撤销。' });
      return;
    }
    if (t.closest('details')) return;
    const step = t.closest<HTMLElement>('.ag-msg.step.go, .ag-msg.turn');
    const ids = step?.dataset.ids?.split(',').map(Number).filter((id) => host.doc().elems[id]) ?? [];
    if (ids.length) host.focus(ids);
  });
  el.querySelector('.ag-head')!.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'close') toggle(false);
    else if (a === 'settings') showSettings(setEl.hidden);
    else if (a === 'clear') { if (running) running.abort(); messages = []; intro(); }
  });
  setEl.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'done') showSettings(false);
    else if (a === 'forget') { cfg.key = ''; saveCfg(); renderSettings(); host.flash('已清除保存的 API Key'); }
  });

  function toggle(on = el.hidden) {
    el.hidden = !on;
    host.layout(on);
    if (on) { if (!listEl.children.length) intro(); if (!ready()) showSettings(true); else input.focus(); }
  }
  return { toggle, isOpen: () => !el.hidden, isRunning: () => !!running };
}
