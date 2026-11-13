// AI 制图：工具集、agent 循环、模型接口的解析。全程不联网——模型用假的，接口用假的 fetch。
import { MUTATING, TOOLS, catalogText, runTool } from '../src/box/ai/tools';
import { runTurn, systemPrompt, trimHistory } from '../src/box/ai/agent';
import { type ChatMsg, type Llm, type LlmReply, makeLlm } from '../src/box/ai/llm';
import { checkLevel } from '../src/box/check';
import { lintDesign } from '../src/box/ai/lint';
import { splitPathCall } from '../src/box/ai/path';
import { solve } from '../src/box/solve';
import { Box, Doc, Elem, Obj, Piece, RailElem, emptyDoc } from '../src/box/types';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void | Promise<void>) => void;
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (d: Doc, name: string, args: unknown) => { const o = runTool(d, name, args); return { ...o, r: o.result as R }; };

export function boxAiScenarios(check: Check, scenario: Scenario) {
  scenario('AI 工具：说明和实现一一对应', () => {
    const names = TOOLS.map((t) => t.function.name);
    check(new Set(names).size === names.length && names.length >= 15, `工具名不重复（${names.length} 个）`);
    const d = emptyDoc();
    for (const n of names) check(!String((run(d, n, {}).r ?? {}).error ?? '').startsWith('没有这个工具'), `${n} 有实现`);
    check(run(d, 'no_such_tool', {}).r.error.includes('没有这个工具'), '不认识的工具名告诉模型');
    check(names.filter((n) => !MUTATING.has(n)).sort().join() === 'ask_user,check_level,focus,get_map,get_section', '不改地图的工具只有这五个');
    check(run(d, 'ask_user', { question: '难度？' }).r.error.includes('没法询问') && !run(d, 'ask_user', {}).mutated, '没有对话面板时 ask_user 让模型自己定');
    const sp = systemPrompt();
    check(['压断软木桥', '被风扇吹起', '跷跷板', '反复经过', 'ask_user', 'mark', '不是规定'].every((w) => sp.includes(w)), '系统提示里有三种球的脾气、非单向的路线、询问用户、记号，并说明这些是参照不是规定');
    for (const t of TOOLS) check(t.function.description.length > 5 && (t.function.parameters as R).type === 'object', `${t.function.name} 有说明和参数表`);
    check(catalogText().includes('PE_Balloon') && catalogText().includes('Level2_WaveWood') && !catalogText().includes('SkyLayer'), '系统提示里有机关表和素材表（云层走 add_sky）');
    check(systemPrompt().length > 1500 && systemPrompt().includes('7.386') && systemPrompt().includes('4.924'), '系统提示里有盘点路口的尺寸');
  });

  scenario('AI 工具：搭一条能通过检查的最小关卡', () => {
    const d = emptyDoc();
    const s = run(d, 'add_pieces', { pieces: [{ kind: 'start', x: 0, y: 0, z: 0, dir: 0 }] });
    const port = s.r.added[0].ports[0];
    check(s.mutated && near(port.x, 7.386) && near(port.y, 0) && port.dir === 0, `起点的路口：${JSON.stringify(port)}`);
    check(run(d, 'add_pieces', { pieces: [{ kind: 'start', x: 50, y: 0 }] }).r.errors[0].error.includes('已经有起点'), '第二个起点被拒绝，并说明原因');

    // 路从路口开始，到小节盘点的路口为止；盘点另一侧再接一段，尽头是飞船的那一格
    const r1 = run(d, 'add_roads', { roads: [{ x: port.x, y: -2.5, sx: 20, sy: 5 }] });
    check(r1.r.added[0].touches.length === 1 && r1.changed.length === 1, `第一段路接上了起点：touches ${JSON.stringify(r1.r.added[0].touches)}`);
    const cx = port.x + 20 + 4.924;
    const c = run(d, 'add_pieces', { pieces: [{ kind: 'checkpoint', x: cx, y: 0, dir: 0 }] });
    const ports = c.r.added[0].ports;
    check(ports.length === 2 && near(Math.min(ports[0].x, ports[1].x), port.x + 20) && near(Math.max(ports[0].x, ports[1].x), cx + 4.924), `小节盘点两侧各一个路口：${JSON.stringify(ports)}`);
    const r2 = run(d, 'add_roads', { roads: [{ x: cx + 4.924, y: -2.5, sx: 25, sy: 5 }, { x: 500, y: 500, sx: 5, sy: 5 }] });
    check(r2.r.added[0].touches.length === 1 && r2.r.added[1].touches.length === 0, '第二段接上了盘点；远处那块没接上任何路（touches 是空的）');
    const endX = cx + 4.924 + 25 - 2.5;
    const b = run(d, 'add_objects', { objects: [{ type: 'PE_Balloon', x: endX, y: 0, z: 0, dir: 2 }] });
    const cell = b.r.added[0].cells[0];
    check(near(cell.x, endX) && near(cell.y, 0) && near(cell.z, 0) && b.r.added[0].x > endX + 20, `飞船对准的那一格在路的尽头，本体在更远处：${JSON.stringify(cell)} / 原点 x ${b.r.added[0].x}`);
    run(d, 'add_sky', { z: -60 });
    check(run(d, 'add_sky', { z: -80 }).r.error.includes('已经有云层'), '第二个云层被拒绝');
    run(d, 'add_death_zone', { x: -100, y: -100, z: -25, sx: 300, sy: 200 });

    let chk = run(d, 'check_level', {});
    check(chk.r.issues.length === 0 && chk.r.road_groups === 2 && !chk.mutated, `关卡检查通过；远处那块路单独成一片（${chk.r.road_groups} 片）：${JSON.stringify(chk.r.issues)}`);
    const stray = r2.r.added[1].id;
    check(run(d, 'delete_elements', { ids: [stray] }).r.deleted === 1 && !d.elems[stray], '删掉没接上的那块');
    chk = run(d, 'check_level', {});
    check(chk.r.road_groups === 1 && checkLevel(d).length === 0, '删掉以后路面连成一片');
    // 真的求解一遍：外沿只有一圈（起点、路、盘点、路连在一起）
    check(solve(d).loops.length >= 1 && solve(d).meshes.size >= 1, '求解器能解出网格和外沿');
    const map = run(d, 'get_map', {});
    check(map.r.count === Object.keys(d.elems).length && map.r.sectors === 2 && map.r.elements.length === map.r.count && !map.mutated, `get_map：${map.r.count} 个元素，${map.r.sectors} 个小节`);
  });

  scenario('AI 工具：机关、钢轨、木制件、护栏', () => {
    const d = emptyDoc();
    run(d, 'add_roads', { roads: [{ x: 0, y: 0, sx: 30, sy: 5 }, { x: 30, y: 0, sx: 10, sy: 5, slope_axis: 'x', slope_dz: 4, style: 'sink' }] });
    const slope = d.elems[2] as Box;
    check(slope.slope?.axis === 0 && slope.slope.dz === 4 && slope.style === 'sink', '坡和样式');
    // 推板有两个对准方块：结果里告诉模型两格路面各在哪
    const m = run(d, 'add_objects', { objects: [{ type: 'P_Modul_25', x: 20, y: 2.5, z: 0, dir: 0, sector: 3 }, { type: 'P_Box', x: 5, y: 2.5, z: 0 }, { type: 'P_Nope', x: 0, y: 0 }] });
    const push = m.r.added[0], boxE = d.elems[m.r.added[1].id] as Obj;
    check(push.cells.length === 2 && near(push.cells[0].x, 20) && near(push.cells[1].x, 4.94) && push.sector === 1, `推板的两格：${JSON.stringify(push.cells.map((c: R) => c.x))}；小节号超出范围时收到现有的小节数里（${push.sector}）`);
    check(near(boxE.z, 2.6) && m.r.errors.length === 1 && m.r.errors[0].index === 2 && m.r.errors[0].error.includes('P_Box'), `箱子抬高一点防穿模（z ${boxE.z}）；不认识的类型报错并列出可用的`);

    const rl = run(d, 'add_rails', { rails: [{ x: 40, y: 2.5, z: 4, heading: 0, segments: [{ length: 10 }, { radius: 10, angle: 90, dz: 2 }] }] });
    const end = rl.r.added[0].end;
    check(near(end.x, 60, 0.05) && near(end.y, 12.5, 0.05) && near(end.z, 6, 0.05) && near(end.heading, 90, 1), `钢轨的终点和方向：${JSON.stringify(end)}`);
    check(run(d, 'add_rails', { rails: [{ x: 0, y: 0, segments: [{ radius: 5 }] }] }).r.errors[0].error.includes('length'), '直线段没给长度：报错');
    const up = run(d, 'update_elements', { updates: [{ id: rl.r.added[0].id, kind: 'mono', heading: 90 }, { id: 1, sx: 35, style: 'ribbon' }, { id: 1, heading: 10 }, { id: 999, x: 1 }] });
    check((d.elems[rl.r.added[0].id] as RailElem).pieces.every((p) => p.kind === 'mono') && (d.elems[1] as Box).sx === 35 && (d.elems[1] as Box).style === 'ribbon', '改钢轨的轨型和朝向、路面的尺寸和样式');
    check(up.r.updated.length === 2 && up.r.errors.length === 2 && up.r.errors[0].error.includes('heading') && up.r.errors[1].error.includes('999'), `改不了的字段和不存在的 id 各自报错，别的照常改：${JSON.stringify(up.r.errors)}`);

    const as = run(d, 'add_assets', { assets: [{ name: 'Level2_WaveWood', x: 0, y: 30, z: 0, dir: 0, length: 65.774 }, { name: 'Modul_02', x: 0, y: 50, length: 20 }] });
    const wave = d.elems[as.r.added[0].id] as Extract<Elem, { kind: 'asset' }>;
    check(near(wave.scale![0] * 180.8776, 65.774, 0.01) && near(as.r.added[0].bounds[0], -65.774, 0.01), `波浪板按长度接长 / 截断：范围 ${JSON.stringify(as.r.added[0].bounds)}`);
    check(as.r.errors[0].error.includes('不能改长度') && Object.values(d.elems).filter((e) => e.kind === 'asset').length === 1, '不能拉伸的素材给了 length：报错，而且不留下半成品');

    const g = run(d, 'add_guards', { at: [{ x: 15, y: 0.3, z: 0 }, { x: 15, y: 200, z: 0 }] });
    check(g.r.added.length === 1 && near(g.r.added[0].length, 30 - 3) && g.r.errors.length === 1, `护栏沿整条直边放（两头各缩 1.5）：长 ${g.r.added[0]?.length}；离路太远的点报错`);
  });

  scenario('AI 工具：整体平移、旋转、镜像、复制', () => {
    const d = emptyDoc();
    run(d, 'add_roads', { roads: [{ x: 0, y: 0, sx: 10, sy: 5 }, { x: 10, y: 0, sx: 5, sy: 15 }] });
    run(d, 'move_elements', { ids: [1, 2], dx: 5, dz: 3 });
    check((d.elems[1] as Box).x === 5 && (d.elems[1] as Box).z === 3 && (d.elems[2] as Box).x === 15, '平移');
    check(run(d, 'move_elements', { ids: [1] }).r.error.includes('至少') && run(d, 'move_elements', { ids: [77], dx: 1 }).r.error.includes('77'), '位移全是 0、id 不存在：报错');
    const dup = run(d, 'duplicate_elements', { ids: [1], dy: 10, count: 3 });
    check(dup.r.new_ids.length === 3 && dup.r.new_ids.map((id: number) => (d.elems[id] as Box).y).join() === '10,20,30', `等距复制三份：${dup.r.new_ids.map((id: number) => (d.elems[id] as Box).y)}`);
    const mir = run(d, 'mirror_elements', { ids: [1, 2], axis: 'x', at: 0 });
    check(mir.r.mirrored === 2 && near((d.elems[1] as Box).x, -15) && near((d.elems[2] as Box).x, -20), `沿 x = 0 镜像：${(d.elems[1] as Box).x} / ${(d.elems[2] as Box).x}`);
    run(d, 'add_objects', { objects: [{ type: 'P_Box', x: 0, y: 0 }] });
    const obj = Object.values(d.elems).find((e) => e.kind === 'obj')!;
    const m2 = run(d, 'mirror_elements', { ids: [obj.id], axis: 'y' });
    check(m2.r.mirrored === 0 && m2.r.skipped === 1 && !m2.mutated, '只有机关时镜像什么都没做：不算改动');
    const rot = run(d, 'rotate_elements', { ids: [1], degrees: 90, cx: 0, cy: 0 });
    const b1 = d.elems[1] as Box;
    check(rot.mutated && rot.r.elements.length === 1, '旋转返回转完以后的样子');
    check(solve(d).meshes.size > 0 && b1.kind === 'box', '转完还能求解');
  });

  scenario('AI 循环：模型调用工具 → 执行 → 把结果还给它，直到它说完', async () => {
    const d = emptyDoc();
    const seen: ChatMsg[][] = [];
    // 假模型：按顺序给出三次回复
    const script: LlmReply[] = [
      { content: '先放起点和第一段路。', calls: [{ id: 'a', name: 'add_pieces', arguments: '{"pieces":[{"kind":"start","x":0,"y":0}]}' }, { id: 'b', name: 'add_roads', arguments: '{"roads":[{"x":7.386,"y":-2.5,"sx":20,"sy":5}]}' }] },
      { content: '', calls: [{ id: 'c', name: 'check_level', arguments: '' }, { id: 'd', name: 'add_roads', arguments: '{坏的 JSON' }] },
      { content: '搭好了开头，还缺终点。', calls: [] },
    ];
    let turn = 0;
    const llm: Llm = async (messages, tools, { onText }) => { seen.push(JSON.parse(JSON.stringify(messages))); check(tools.length === TOOLS.length, '每次都带着工具表'); const r = script[turn++]; if (r.content) onText?.(r.content); return r; };
    const log: string[] = [];
    const messages: ChatMsg[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: '做个关卡' }];
    const end = await runTurn({
      llm, messages,
      exec: (name, args) => { const o = runTool(d, name, args); return { result: o.result, summary: o.summary, ok: !(o.result as R).error }; },
      on: { text: (t) => log.push(`text:${t}`), toolStart: (c) => log.push(`start:${c.name}`), toolEnd: (c, r) => log.push(`end:${c.name}:${r.ok}`) },
    });
    check(end === 'done' && turn === 3, `三次来回后结束（${end}，${turn} 次）`);
    check(Object.keys(d.elems).length === 2 && (d.elems[2] as Box).sx === 20 && (d.elems[1] as Piece).type === 'start', '工具真的改了地图');
    check(log.join('|') === 'text:先放起点和第一段路。|start:add_pieces|end:add_pieces:true|start:add_roads|end:add_roads:true|start:check_level|end:check_level:true|start:add_roads|end:add_roads:false|text:搭好了开头，还缺终点。', `每一步都通知了界面：${log.join('|')}`);
    // 对话记录的形状：assistant（带 tool_calls）后面紧跟每个调用的结果，服务商才认
    const roles = messages.map((m) => m.role).join(',');
    check(roles === 'system,user,assistant,tool,tool,assistant,tool,tool,assistant', `对话记录：${roles}`);
    check(messages[2].tool_calls!.length === 2 && messages[3].tool_call_id === 'a' && messages[4].tool_call_id === 'b' && messages[5].content === null, '每个工具调用都有对应的结果；没说话的回合 content 是 null');
    check(JSON.parse(messages[7].content!).error.includes('JSON') && messages[5].tool_calls![0].function.arguments === '{}', '参数不是合法 JSON：告诉模型重来；空参数补成 {}');
    check(seen[1].length === 5 && seen[2].length === 8 && JSON.parse(seen[2][6].content!).issues.length > 0, '模型第二、三次看到了前面工具的结果');
  });

  scenario('AI 循环：喊停、步数上限、对话太长时的裁剪', async () => {
    const d = emptyDoc();
    const exec = (name: string, args: unknown) => { const o = runTool(d, name, args); return { result: o.result, summary: o.summary, ok: true }; };
    // 停不下来的模型：一直加路
    let n = 0;
    const loopy: Llm = async () => ({ content: '', calls: [{ id: `k${n}`, name: 'add_roads', arguments: `{"roads":[{"x":${n++ * 5},"y":0,"sx":5,"sy":5}]}` }] });
    const m1: ChatMsg[] = [{ role: 'user', content: 'go' }];
    check(await runTurn({ llm: loopy, messages: m1, exec, maxSteps: 4 }) === 'max-steps' && Object.keys(d.elems).length === 4, '到步数上限就停');

    // 中途喊停：第一步执行完就停；同一回合里还没执行的工具也要补一条结果
    const ctl = new AbortController();
    const two: Llm = async () => ({ content: '', calls: [{ id: 'x', name: 'add_roads', arguments: '{"roads":[{"x":100,"y":0,"sx":5,"sy":5}]}' }, { id: 'y', name: 'add_roads', arguments: '{"roads":[{"x":105,"y":0,"sx":5,"sy":5}]}' }] });
    const m2: ChatMsg[] = [{ role: 'user', content: 'go' }];
    const before = Object.keys(d.elems).length;
    const end = await runTurn({ llm: two, messages: m2, exec: (a, b) => { const r = exec(a, b); ctl.abort(); return r; }, signal: ctl.signal });
    check(end === 'aborted' && Object.keys(d.elems).length === before + 1, '喊停后剩下的工具不再执行');
    check(m2.length === 4 && m2[3].tool_call_id === 'y' && JSON.parse(m2[3].content!).error.includes('中止'), '没执行的调用也有一条结果，对话记录还是配对的');
    const dead = new AbortController(); dead.abort();
    check(await runTurn({ llm: two, messages: [{ role: 'user', content: 'x' }], exec, signal: dead.signal }) === 'aborted', '一开始就已经喊停：不请求模型');
    // 模型接口抛错：往外抛，让界面显示
    let threw = '';
    try { await runTurn({ llm: async () => { throw new Error('API Key 不对'); }, messages: [{ role: 'user', content: 'x' }], exec }); } catch (e) { threw = (e as Error).message; }
    check(threw === 'API Key 不对', '接口出错往外抛');

    const big = 'x'.repeat(30_000);
    const hist: ChatMsg[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i++) hist.push({ role: 'user', content: `第 ${i} 轮` }, { role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'get_map', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `t${i}`, content: big }, { role: 'assistant', content: '好了' });
    const cut = trimHistory(hist, 100_000);
    const firstUser = cut.findIndex((m) => m.content?.startsWith('第 '));
    check(cut[0].role === 'system' && cut.length < hist.length && cut[firstUser].role === 'user' && cut[cut.length - 1].content === '好了', '裁掉最早的几轮，系统提示和最近的留着');
    const calls = cut.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []), results = cut.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    check(calls.length > 0 && calls.join() === results.join(), '裁完以后工具调用和结果还是一一对应');
    check(trimHistory(hist, 10_000_000) === hist, '不长就原样返回');
  });

  scenario('模型接口：流式返回的解析、出错时的说明', async () => {
    const enc = new TextEncoder();
    /** 把一串 SSE 文本按给定的切法切成几块，模拟网络上一段一段到 */
    const stream = (text: string, sizes: number[]) => new ReadableStream<Uint8Array>({
      start(c) { const bytes = enc.encode(text); let at = 0, i = 0; while (at < bytes.length) { const n = sizes[i++ % sizes.length]; c.enqueue(bytes.slice(at, at + n)); at += n; } c.close(); },
    });
    const ev = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const sse = ev({ role: 'assistant', content: '' }) + ev({ content: '先放' }) + ev({ content: '起点。' })
      + ev({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'add_pieces', arguments: '' } }] })
      + ev({ tool_calls: [{ index: 0, function: { arguments: '{"pieces":[{"kind"' } }] }) + ev({ tool_calls: [{ index: 0, function: { arguments: ':"start","x":0,"y":0}]}' } }] })
      + ev({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'check_level', arguments: '{}' } }] })
      + ': keep-alive\n\n' + 'data: [DONE]\n\n';
    let sent: R = {};
    const fake = (res: () => Response): typeof fetch => (async (url: string, init: R) => { sent = { url, ...init, body: JSON.parse(init.body) }; return res(); }) as unknown as typeof fetch;
    for (const sizes of [[4096], [7], [1, 2, 3, 50]]) {
      let text = '';
      const r = await makeLlm({ base: 'https://api.example.com/v1/', model: 'm1', key: 'sk-test' }, fake(() => new Response(stream(sse, sizes), { status: 200 })))([{ role: 'user', content: 'hi' }], TOOLS, { onText: (t) => { text += t; } });
      check(r.content === '先放起点。' && text === '先放起点。', `文字一段段交给界面（每块 ${sizes} 字节）`);
      check(r.calls.length === 2 && r.calls[0].id === 'call_1' && r.calls[0].name === 'add_pieces' && JSON.parse(r.calls[0].arguments).pieces[0].kind === 'start' && r.calls[1].name === 'check_level', `工具调用的碎片拼回完整的（每块 ${sizes} 字节）`);
    }
    check(sent.url === 'https://api.example.com/v1/chat/completions' && sent.headers.Authorization === 'Bearer sk-test' && sent.body.model === 'm1' && sent.body.stream === true && sent.body.tools.length === TOOLS.length, '请求发到 base/chat/completions，带着 Key、模型名和工具表');
    const fails = async (res: () => Response) => { try { await makeLlm({ base: 'https://api.example.com/v1', model: 'm', key: 'k' }, fake(res))([], [], {}); return ''; } catch (e) { return (e as Error).message; } };
    check((await fails(() => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 }))).includes('API Key 不对') , '401：Key 不对');
    check((await fails(() => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 }))).includes('余额不足'), '402：余额不足');
    check((await fails(() => new Response('nope', { status: 404 }))).includes('地址或模型名不对'), '404：地址或模型名不对');
    check((await fails(() => new Response(stream(`data: ${JSON.stringify({ error: { message: '模型过载' } })}\n\n`, [64]), { status: 200 }))).includes('模型过载'), '流里带的错误也报出来');
    const net = makeLlm({ base: 'https://api.example.com/v1', model: 'm', key: 'k' }, (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch);
    let msg = ''; try { await net([], [], {}); } catch (e) { msg = (e as Error).message; }
    check(msg.includes('连不上 api.example.com') && msg.includes('跨域'), '连不上：提示网络和跨域');
  });

  scenario('AI 铺赛道：一句话的入门关，接头、转换、盘点、飞船都自动对上', () => {
    const STEPS = [
      { do: 'start' }, { do: 'road', length: 20 }, { do: 'object', type: 'P_Extra_Point' }, { do: 'road', length: 20, style: 'sink' }, { do: 'turn', to: 'right' }, { do: 'guard', side: 'left' }, { do: 'road', length: 10 },
      { do: 'rail', length: 20 }, { do: 'spiral', to: 'left', radius: 10, turns: 1, rise: 10 }, { do: 'rail', length: 20 },
      { do: 'road', length: 15, style: 'normal' }, { do: 'checkpoint' }, { do: 'road', length: 20 }, { do: 'object', type: 'P_Modul_25' }, { do: 'road', length: 10 }, { do: 'balloon' },
    ];
    const d = emptyDoc();
    const r = run(d, 'build_path', { from: { x: 0, y: 0, z: 0, dir: 0 }, steps: STEPS });
    check(!r.r.error && r.r.steps.length === STEPS.length && r.mutated, `${STEPS.length} 步都做成了：${r.r.error ?? ''}`);
    const kinds = (k: string) => Object.values(d.elems).filter((e) => (e.kind === 'piece' ? e.type : e.kind === 'obj' ? e.type : e.kind) === k);
    // 平路 → 凹路之间自动垫了一块平凹转换，朝向是从凹路指向平路
    const tr = kinds('transition')[0] as Piece;
    check(!!tr && tr.rot === 2 && near(tr.x, 7.386 + 20 + 2.5) && r.r.steps[3].note.includes('平凹转换'), `平凹转换自动垫上，从凹路（前面）指向平路（后面）：rot ${tr?.rot}，x ${tr?.x}`);
    // 右转以后朝 -Y；钢轨一整条（直 + 螺旋 + 直），升了 10
    const rails = kinds('rail') as RailElem[];
    check(rails.length === 1 && rails[0].pieces.length === 3 && rails[0].heading === 270 && rails[0].pieces[1].angle === 360, '连着的三步钢轨是一条，从拐弯后的方向出发');
    check(r.r.cursor.z === 10 && r.r.cursor.dir === 3 && r.r.cursor.sector === 2, `铺完以后光标在高处、朝 -Y、第 2 小节：${JSON.stringify(r.r.cursor)}`);
    // 推板架在两段路之间；飞船在路的尽头前方（-Y 方向更远处），没有压在路上
    const push = kinds('P_Modul_25')[0] as Obj, bal = kinds('PE_Balloon')[0] as Obj;
    check(push.sector === 2 && r.r.steps[13].ids.length === 2, '盘点后面的机关自动算进第 2 小节；推板另一头补了一格路');
    const roadsY = (Object.values(d.elems).filter((e) => e.kind === 'box') as Box[]).map((b) => b.y);
    check(bal.y < Math.min(...roadsY) - 15, `飞船本体在所有路的前方：y ${bal.y.toFixed(1)}，最远的路 y ${Math.min(...roadsY).toFixed(1)}`);
    check(kinds('guard').length === 1, '弯道外侧装了一条护栏');
    run(d, 'add_sky', { z: -60 });
    run(d, 'add_death_zone', { x: -100, y: -220, z: -25, sx: 400, sy: 400 });
    const chk = run(d, 'check_level', {});
    check(chk.r.issues.length === 0 && chk.r.design_problems.length === 0, `关卡检查和设计检查都干净：${JSON.stringify(chk.r.issues)} ${JSON.stringify(chk.r.design_problems)}`);
    check(solve(d).meshes.size > 0, '能求解');

    // 界面上是拆成一小步一小步执行的：结果要和一次铺完一模一样
    const d2 = emptyDoc();
    const parts = splitPathCall({ from: { x: 0, y: 0, z: 0, dir: 0 }, steps: STEPS });
    check(parts.length === STEPS.length - 2 && (parts[7].steps as unknown[]).length === 3 && parts[8].step_offset === 10, `拆成 ${parts.length} 小次：连着的钢轨在同一次里`);
    const nums: number[] = [];
    for (const part of parts) { const o = run(d2, 'build_path', part); check(!o.r.error, `分步执行：${o.r.error ?? 'ok'}`); nums.push(...o.r.steps.map((x: R) => x.step)); }
    check(JSON.stringify(d2.elems) === JSON.stringify(d.elems ? Object.fromEntries(Object.entries(d.elems).filter(([, e]) => e.kind !== 'zone' && e.kind !== 'asset')) : {}), '分步铺出来的和一次铺完的一样');
    check(nums.join() === STEPS.map((_, i) => i + 1).join(), '分步执行时步骤的编号还是整条里的编号');
  });

  scenario('AI 铺赛道：接着铺、坡、落差、木制件、出错时停在哪', () => {
    const d = emptyDoc();
    run(d, 'build_path', { from: { x: 0, y: 0, z: 5, dir: 1 }, steps: [{ do: 'road', length: 10 }, { do: 'road', length: 10, rise: 4 }] });
    const slope = d.elems[2] as Box;
    check(slope.slope?.axis === 1 && slope.slope.dz === 4 && slope.z === 5 && slope.y === 10, '朝 +Y 的上坡：低的一头在起点');
    // 不给 from：从上次停下的地方接着铺（高度、方向、样式都接着）
    const r2 = run(d, 'build_path', { steps: [{ do: 'road', length: 10, rise: -4 }, { do: 'turn', to: 'left' }, { do: 'road', length: 10, rise: 2 }, { do: 'gap', length: 5, drop: 6 }, { do: 'platform', length: 15, width: 15 }] });
    const down = d.elems[3] as Box, west = d.elems[5] as Box, plat = d.elems[6] as Box;
    check(down.y === 20 && down.z === 9 && down.slope!.dz === -4, `接着铺的下坡从坡顶开始：y ${down.y} z ${down.z}`);
    check(west.slope!.axis === 0 && west.slope!.dz === -2 && near(west.z, 7) && near(west.x + west.sx, -2.5), `左转以后朝 -X 的上坡：高的一头在坐标小的那边（z ${west.z}，dz ${west.slope!.dz}）`);
    check(near(plat.z, 1) && plat.sy === 15 && near(plat.y + 7.5, 32.5) && near(plat.x + plat.sx, -17.5), `落差 6 之后的平台居中接住：z ${plat.z}`);
    check(r2.r.cursor.dir === 2 && near(r2.r.cursor.z, 1), '光标跟着走');
    // 木制件顺着赛道放：波浪板取整数个周期，末端和开头一样高
    const r3_ = run(d, 'build_path', { steps: [{ do: 'asset', name: 'Level2_WaveWood', length: 60 }, { do: 'road', length: 10 }] });
    const wave = Object.values(d.elems).find((e) => e.kind === 'asset') as Extract<Elem, { kind: 'asset' }>;
    check(!r3_.r.error && near(wave.scale![0] * 180.8776, 2 * 32.88709, 0.01) && wave.rot === 0 && near(r3_.r.cursor.z, 1), `波浪板朝 -X 放（模型本来就朝 -X），长取两个周期：${(wave.scale![0] * 180.8776).toFixed(2)}`);
    // 出错：前面的保留，说明停在第几步
    const before = Object.keys(d.elems).length;
    const bad = run(d, 'build_path', { steps: [{ do: 'road', length: 5 }, { do: 'rail', length: 10 }, { do: 'rail_turn', to: 'left', angle: 45 }, { do: 'road', length: 5 }, { do: 'road', length: 99 }] });
    check(bad.r.error.includes('第 4 步') && bad.r.error.includes('不是正方向') && bad.r.steps.length === 3 && Object.keys(d.elems).length === before + 2, `斜着结束的钢轨后面接不了路：${bad.r.error}`);
    check(run(emptyDoc(), 'build_path', { steps: [{ do: 'road', length: 5 }] }).r.error.includes('要给 from'), '新地图第一次铺要给 from');
    check(run(d, 'build_path', { steps: [{ do: 'road', length: 5, rise: 9 }] }).r.error.includes('太陡'), '太陡的坡被拒绝');
    check(run(d, 'build_path', { steps: [{ do: 'object', type: 'P_Modul_37' }] }).r.error.includes('add_objects'), '对准方块不在一条线上的机关：让模型改用 add_objects');
  });

  scenario('设计检查：大模型常犯的错都能指出来', () => {
    const texts = (d: Doc) => lintDesign(d).map((l) => l.text);
    const has = (d: Doc, part: string) => texts(d).some((t) => t.includes(part));
    // 平路直接接凹路
    let d = emptyDoc();
    run(d, 'add_roads', { roads: [{ x: 0, y: 0, sx: 20, sy: 5 }] });
    const w = run(d, 'add_roads', { roads: [{ x: 20, y: 0, sx: 20, sy: 5, style: 'sink' }] });
    check(w.r.added[0].warning.includes('平凹转换') && has(d, '直接接在一起'), '平路贴凹路：放的时候就提醒，检查时也指出来');
    run(d, 'update_elements', { updates: [{ id: 2, x: 25, sx: 15 }] });
    run(d, 'add_pieces', { pieces: [{ kind: 'transition', x: 22.5, y: 2.5, dir: 2 }] });
    check(!has(d, '直接接在一起'), '中间垫上平凹转换就不报了');
    run(d, 'add_roads', { roads: [{ x: 5, y: 0, sx: 10, sy: 5 }] });
    check(has(d, '叠在一起'), '同一个地方放了两块路');

    // 盘点的路口没接路；飞船压在路上；机关脚下没路；架在两格之间的机关底下有路穿过
    d = emptyDoc();
    run(d, 'add_pieces', { pieces: [{ kind: 'start', x: 0, y: 0 }, { kind: 'checkpoint', x: 40, y: 0 }] });
    run(d, 'add_roads', { roads: [{ x: 7.386, y: -2.5, sx: 27.69, sy: 5 }] });
    check(texts(d).filter((t) => t.includes('路口没有接路')).length === 1 && has(d, '+X'), `盘点另一侧的路口没接路：${texts(d)}`);
    run(d, 'add_roads', { roads: [{ x: 44.924, y: -2.5, sx: 30, sy: 5 }] });
    check(!has(d, '路口没有接路'), '接上以后不报了');
    run(d, 'add_objects', { objects: [{ type: 'PE_Balloon', x: 72.424, y: 0, z: 0, dir: 0 }] });
    check(has(d, '方向反了'), 'dir 朝前的飞船本体压在来路上：指出方向反了');
    run(d, 'update_elements', { updates: [{ id: Object.values(d.elems).find((e) => e.kind === 'obj')!.id, dir: 2 }] });
    const bal = Object.values(d.elems).find((e) => e.kind === 'obj') as Obj;
    run(d, 'move_elements', { ids: [bal.id], dx: 72.424 - describeCell(d, bal.id).x });
    check(!has(d, '方向反了') && !has(d, '底下没有路'), `掉头并对回最后一格以后不报了：${texts(d)}`);
    run(d, 'add_objects', { objects: [{ type: 'P_Box', x: 60, y: 30 }, { type: 'P_Modul_25', x: 65, y: 0, z: 0, dir: 0 }] });
    check(has(d, '箱子') && has(d, '底下没有路') && has(d, '从底下穿过去'), '悬空的箱子；推板底下的路没断开');

    // 钢轨悬空；死亡区和云层的位置
    d = emptyDoc();
    run(d, 'add_roads', { roads: [{ x: 0, y: 0, sx: 20, sy: 5 }] });
    run(d, 'add_rails', { rails: [{ x: 20, y: 2.5, z: 0, heading: 0, segments: [{ length: 20 }] }, { x: 60, y: 30, z: 0, heading: 0, segments: [{ length: 10 }] }] });
    const rl = texts(d).filter((t) => t.includes('钢轨'));
    check(rl.length === 2 && rl[0].includes('终点') && !rl[0].includes('起点') && rl[1].includes('起点') && rl[1].includes('终点'), `第一条只有终点悬空，第二条两头都悬空：${rl}`);
    run(d, 'add_death_zone', { x: 0, y: 0, z: 3, sx: 10, sy: 10 });
    run(d, 'add_sky', { z: -5 });
    check(has(d, '球在路上就会死') && has(d, '没有盖住整张图') && has(d, '云层'), '死亡区在路上面、没盖住；云层太高');
    check(run(d, 'check_level', {}).r.design_problems.length >= 5 && run(d, 'check_level', {}).summary.includes('处搭得不对'), 'check_level 把这些一起还给模型');
  });

  scenario('AI 铺赛道：岔路、环路（mark / goto），撞上别的路时提醒', () => {
    const d = emptyDoc();
    // 主线往 +X，在路上记下「枢纽」；主线接着往前；再回到枢纽往左铺一条支线
    const r = run(d, 'build_path', { from: { x: 0, y: 0, z: 0, dir: 0 }, steps: [
      { do: 'road', length: 20 }, { do: 'mark', name: '枢纽' }, { do: 'road', length: 30 }, { do: 'object', type: 'P_Extra_Point' },
      { do: 'goto', name: '枢纽' }, { do: 'turn', to: 'left' }, { do: 'road', length: 15 }, { do: 'object', type: 'P_Extra_Life' },
    ] });
    check(!r.r.error && r.r.steps[1].note.includes('枢纽') && r.r.steps[5].note.includes('岔路口'), `岔路口的拐角用的是已经在那里的路：${JSON.stringify(r.r.steps[5])} ${r.r.error ?? ''}`);
    const boxes = Object.values(d.elems).filter((e) => e.kind === 'box') as Box[];
    check(boxes.length === 3 && !r.r.collisions, `没有多放一块拐角方块（${boxes.length} 块路），也没有重叠`);
    const branch = boxes[2];
    check(branch.sx === 5 && branch.sy === 15 && near(branch.x, 20) && near(branch.y, 2.5), `支线从主线的侧面出去：${JSON.stringify([branch.x, branch.y, branch.sx, branch.sy])}`);
    check(lintDesign(d).length === 0 && run(d, 'check_level', {}).r.path_marks.join() === '枢纽', `岔路口不算搭错；check_level 里能看到记过的记号：${JSON.stringify(lintDesign(d))}`);
    // 从记号出发的另一次调用，可以换方向
    const r2 = run(d, 'build_path', { from: { mark: '枢纽', dir: 3 }, steps: [{ do: 'gap', length: 2.5 }, { do: 'road', length: 10 }] });
    check(!r2.r.error && r2.r.cursor.dir === 3, 'from: {mark} 换个方向再铺一条');
    check(run(d, 'build_path', { steps: [{ do: 'goto', name: '没有的' }] }).r.error.includes('枢纽'), '记号名写错：告诉模型现有哪些');
    // 绕回来压在自己铺过的路上：结果里指出来
    const d2 = emptyDoc();
    const loop = run(d2, 'build_path', { from: { x: 0, y: 0, dir: 0 }, steps: [{ do: 'road', length: 30 }, { do: 'turn', to: 'left' }, { do: 'road', length: 10 }, { do: 'turn', to: 'left' }, { do: 'road', length: 10 }, { do: 'turn', to: 'left' }, { do: 'road', length: 30 }] });
    check(!loop.r.error && loop.r.collisions?.length >= 1 && loop.r.collisions_note.includes('上下错开'), `绕回来撞上自己的路：${JSON.stringify(loop.r.collisions)}`);
    // 上下错开足够高就不算撞
    const d3 = emptyDoc();
    const over = run(d3, 'build_path', { from: { x: 0, y: 0, dir: 0 }, steps: [{ do: 'road', length: 30 }, { do: 'turn', to: 'left' }, { do: 'road', length: 20, rise: 12 }, { do: 'turn', to: 'left' }, { do: 'road', length: 10 }, { do: 'turn', to: 'left' }, { do: 'road', length: 40 }] });
    check(!over.r.error && !over.r.collisions, `从上面 12 高的地方跨过去不算撞：${JSON.stringify(over.r.collisions)}`);
  });

  scenario('AI 铺赛道：跟踪球种，走不通的地方指出来', () => {
    // 用户遇到过的错：变成木球以后还要靠风扇过去
    const d = emptyDoc();
    const r = run(d, 'build_path', { from: { x: 0, y: 0, dir: 0 }, steps: [
      { do: 'start' }, { do: 'road', length: 30 }, { do: 'object', type: 'P_Modul_18', back: 20 },
      { do: 'object', type: 'P_Trafo_Paper', back: 12 }, { do: 'object', type: 'P_Modul_18', back: 5 },
      { do: 'road', length: 30 }, { do: 'object', type: 'P_Trafo_Wood', back: 25 }, { do: 'object', type: 'P_Modul_18', back: 10 },
      { do: 'object', type: 'P_Trafo_Stone', back: 4 }, { do: 'road', length: 10 }, { do: 'object', type: 'P_Modul_29' },
    ] });
    const lp: string[] = r.r.logic_problems ?? [];
    check(!r.r.error && lp.length === 3, `三处说不通：${JSON.stringify(lp)} ${r.r.error ?? ''}`);
    check(lp[0].includes('第 3 步') && lp[0].includes('木球') && lp[0].includes('纸球变球器'), '起点出来是木球，第一个风扇吹不动');
    check(lp[1].includes('第 8 步') && lp[1].includes('木球'), '变回木球之后的风扇也吹不动（第 5 步那个纸球时的风扇不报）');
    check(lp[2].includes('软木桥') && lp[2].includes('石球'), '石球上软木桥会压断');
    check(r.r.cursor.ball === 'stone' && r.r.steps[3].note.includes('纸球') && r.r.logic_note.includes('必须改'), '光标记着现在是什么球，并告诉模型这是硬错误');
    // 接着铺：球种接着算；纸球撞箱子是提醒
    const r2 = run(d, 'build_path', { steps: [{ do: 'road', length: 20 }, { do: 'object', type: 'P_Trafo_Paper', back: 15 }, { do: 'object', type: 'P_Box', back: 5 }] });
    check(r2.r.logic_problems?.length === 1 && r2.r.logic_problems[0].includes('撞不动'), '纸球撞不动箱子');
    // 设计检查：有风扇的小节之前要有纸球变球器
    const d2 = emptyDoc();
    run(d2, 'add_roads', { roads: [{ x: 0, y: 0, sx: 30, sy: 5 }] });
    run(d2, 'add_objects', { objects: [{ type: 'P_Modul_18', x: 12.5, y: 2.5 }] });
    check(lintDesign(d2).some((l) => l.text.includes('没有纸球变球器')), '手动放的风扇，前面没有纸球变球器');
    run(d2, 'add_objects', { objects: [{ type: 'P_Trafo_Paper', x: 2.5, y: 2.5 }] });
    check(!lintDesign(d2).some((l) => l.text.includes('没有纸球变球器')), '放了就不报');
  });

  scenario('AI 铺赛道：connect 自动接回路口；get_section + 重做一个小节', () => {
    const near2 = (c: R, x: number, y: number) => near(c.x, x, 0.01) && near(c.y, y, 0.01);
    // 各种相对位置：直着、拐一个弯、错开（两个弯）、掉头、带高度差
    const cases: [string, R, number][] = [
      ['正前方', { x: 30, y: 0, z: 0, dir: 0 }, 1], ['左前方拐一个弯', { x: 20, y: 15, z: 0, dir: 1 }, 3], ['右前方拐一个弯', { x: 20, y: -15, z: 0, dir: 3 }, 3],
      ['同向但错开', { x: 40, y: 20, z: 0, dir: 0 }, 5], ['掉头', { x: -10, y: 20, z: 0, dir: 2 }, 5], ['正前方高 6', { x: 30, y: 0, z: 6, dir: 0 }, 1],
    ];
    for (const [name, to, n] of cases) {
      const d = emptyDoc();
      const r = run(d, 'build_path', { from: { x: 0, y: 0, z: 0, dir: 0 }, steps: [{ do: 'connect', to }] });
      check(!r.r.error && near2(r.r.cursor, to.x, to.y) && r.r.cursor.dir === to.dir && near(r.r.cursor.z, to.z) && r.r.steps[0].ids.length === n, `${name}：接上了，${r.r.steps[0]?.ids.length} 块路（${r.r.error ?? r.r.steps[0].note}）`);
      check(!r.r.collisions && lintDesign(d).length === 0, `${name}：路没有叠在一起`);
    }
    const bad = run(emptyDoc(), 'build_path', { from: { x: 0, y: 0, dir: 0 }, steps: [{ do: 'connect', to: { x: -30, y: 0, dir: 0 } }] });
    check(bad.r.error.includes('接不到') && bad.r.error.includes('正后方'), '在正后方：说明为什么接不过去、还差多少');

    // 一张三个小节的图，把第二小节删掉重做，前后不动
    const d = emptyDoc();
    run(d, 'build_path', { from: { x: 0, y: 0, dir: 0 }, steps: [
      { do: 'start' }, { do: 'road', length: 20 }, { do: 'checkpoint' },
      { do: 'road', length: 40 }, { do: 'object', type: 'P_Extra_Point', back: 20 }, { do: 'checkpoint' },
      { do: 'road', length: 20 }, { do: 'balloon' },
    ] });
    const s2 = run(d, 'get_section', { sector: 2 });
    check(s2.r.ids.length === 2 && !s2.mutated && s2.r.of === 3, `第二小节有一段路和一个分数球：${JSON.stringify(s2.r.ids)}`);
    check(s2.r.entry.dir === 0 && s2.r.exit.dir === 0 && near(s2.r.exit.x - s2.r.entry.x, 40) && s2.r.howto.includes('connect'), `入口和出口相距 40，方向都是 +X：${JSON.stringify([s2.r.entry, s2.r.exit])}`);
    const others = JSON.stringify(Object.values(d.elems).filter((e) => !s2.r.ids.includes(e.id)));
    run(d, 'delete_elements', { ids: s2.r.ids });
    const re = run(d, 'build_path', { from: s2.r.entry, steps: [{ do: 'road', length: 10 }, { do: 'turn', to: 'left' }, { do: 'road', length: 10, rise: 3 }, { do: 'platform', length: 15, width: 15 }, { do: 'object', type: 'P_Extra_Life' }, { do: 'turn', to: 'right' }, { do: 'connect', to: s2.r.exit }] });
    check(!re.r.error && !re.r.collisions, `重铺并接回出口：${re.r.error ?? ''} ${JSON.stringify(re.r.collisions ?? '')}`);
    check(JSON.stringify(Object.values(d.elems).filter((e) => !re.changed.includes(e.id))) === others, '前后两个小节的东西原封不动');
    const chk = run(d, 'check_level', {});
    check(chk.r.design_problems.length === 0 && chk.r.road_groups === 1, `重做以后整条路还是连着的，没有搭错的地方：${JSON.stringify(chk.r.design_problems)} / ${chk.r.road_groups} 片`);
    check(run(d, 'get_section', { sector: 2 }).r.ids.length === re.changed.length && run(d, 'get_section', { sector: 3 }).r.exit === null && run(d, 'get_section', { sector: 9 }).r.error.includes('3 个小节'), '重做后再查：第二小节就是新铺的这些；最后一节没有出口盘点；小节号超范围报错');
  });
}

/** 机关第一个对准方块的位置（从 get_map 里取） */
function describeCell(d: Doc, id: number): { x: number; y: number } {
  const m = runTool(d, 'get_map', {}).result as R;
  return m.elements.find((e: R) => e.id === id).cells[0];
}
