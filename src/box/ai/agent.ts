// AI 制图的一轮对话：把用户的话交给模型 → 模型要调用工具就执行、把结果还给它 → 再问模型……直到它不再调用工具（说完了）。
// 这里不碰界面和地图：模型怎么调（llm）、工具怎么执行（exec）、每一步通知谁（on）都是传进来的，所以能用假的模型来测。
import type { ChatMsg, Llm, ToolCall } from './llm';
import { TOOLS, catalogText } from './tools';
import { CP_PORT } from '../types';
import { DESIGN_GUIDE } from './knowledge';

export interface StepResult { result: unknown; summary: string; ok: boolean }
export interface AgentEvents {
  /** 模型开始说话 / 说了一段 */
  text?: (delta: string) => void;
  /** 模型这一回合说完了（content 是这一回合完整的话，可能是空的） */
  said?: (content: string) => void;
  /** 要执行一个工具了 / 执行完了 */
  toolStart?: (call: ToolCall, args: unknown) => void;
  toolEnd?: (call: ToolCall, r: StepResult) => void;
}
export interface TurnOptions {
  llm: Llm;
  /** 到这一轮为止的全部对话（会往里追加） */
  messages: ChatMsg[];
  exec: (name: string, args: unknown) => Promise<StepResult> | StepResult;
  on?: AgentEvents;
  signal?: AbortSignal;
  /** 一轮里最多来回多少次（防止模型停不下来） */
  maxSteps?: number;
}
export type TurnEnd = 'done' | 'aborted' | 'max-steps';

/** 模型给的参数是一段 JSON 文本，偶尔不合法：解析不了就把原因告诉它 */
function parseArgs(s: string): { args: unknown; error?: string } {
  if (!s.trim()) return { args: {} };
  try { return { args: JSON.parse(s) }; } catch { return { args: {}, error: '参数不是合法的 JSON，请重新调用' }; }
}

export async function runTurn(o: TurnOptions): Promise<TurnEnd> {
  const max = o.maxSteps ?? 40;
  for (let step = 0; step < max; step++) {
    if (o.signal?.aborted) return 'aborted';
    let reply;
    try { reply = await o.llm(o.messages, TOOLS, { signal: o.signal, onText: o.on?.text }); }
    catch (e) { if ((e as Error).name === 'AbortError' || o.signal?.aborted) return 'aborted'; throw e; }
    o.on?.said?.(reply.content);
    o.messages.push({
      role: 'assistant', content: reply.content || null,
      ...(reply.calls.length ? { tool_calls: reply.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })) } : {}),
    });
    if (!reply.calls.length) return 'done';
    for (let i = 0; i < reply.calls.length; i++) {
      const call = reply.calls[i];
      // 中途喊停：没执行的工具也要有一条结果，不然对话记录对不上，下一轮服务商会拒绝
      if (o.signal?.aborted) { o.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '用户中止了，这一步没有执行' }) }); continue; }
      const { args, error } = parseArgs(call.arguments);
      o.on?.toolStart?.(call, args);
      let r: StepResult;
      try { r = error ? { result: { error }, summary: '参数解析失败', ok: false } : await o.exec(call.name, args); }
      catch (e) { r = { result: { error: `执行出错：${(e as Error).message}` }, summary: `出错：${(e as Error).message}`, ok: false }; }
      o.on?.toolEnd?.(call, r);
      o.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r.result) });
    }
    if (o.signal?.aborted) return 'aborted';
  }
  return 'max-steps';
}

/**
 * 对话太长时丢掉最早的几轮（保留系统提示和最近的），省得超出模型的上下文。
 * 一轮从一条 user 消息开始到下一条 user 之前，整轮一起丢，工具调用和结果不会被拆开。
 */
export function trimHistory(messages: ChatMsg[], maxChars = 160_000): ChatMsg[] {
  const size = (ms: ChatMsg[]) => ms.reduce((s, m) => s + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
  if (size(messages) <= maxChars) return messages;
  const sys = messages.filter((m) => m.role === 'system'), rest = messages.filter((m) => m.role !== 'system');
  const starts = rest.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  let from = 0;
  for (let k = 1; k < starts.length && size(rest.slice(from)) > maxChars; k++) from = starts[k];
  return [...sys, ...(from ? [{ role: 'user' as const, content: '（更早的对话太长，已经省略。需要了解地图现状请调用 get_map。）' }, { role: 'assistant' as const, content: '好的。' }] : []), ...rest.slice(from)];
}

/** 系统提示：告诉模型它在干什么、这个编辑器的规矩、Ballance 关卡的常识 */
export function systemPrompt(): string {
  return `你是 BVM（Ballance Vibe Mapping，一个 Ballance 自制地图编辑器）里的制图助手。用户用自然语言描述想要的关卡，你通过工具在编辑器里把它搭出来；用户能实时看到你的每一步，也会接着提修改意见。

# 怎么干活
- 铺路用 build_path：你只说「往前多长、什么样式、往哪拐、放什么」，位置、接头、平凹转换、盘点和飞船的朝向由编辑器算。不要自己算坐标去 add_roads 拼一条路——很容易差半格、接不上、方向反。add_roads / add_objects / add_pieces 用来零散地补东西，或者放不在路线上的东西。
- 一次 build_path 铺一段（十几二十步），用户能看着它一步步长出来；下一次不给 from 就接着铺。岔路、环路用 mark / goto。
- 不确定地图现状（尤其是用户自己改过之后）就先 get_map。用户提到「选中的」「这段」时，看用户消息开头给出的当前选中的 id。在已有的路后面接着做时，先 get_map 找到那段路的末端，用带 from 的 build_path 接上去。
- 做完一个阶段调用 check_level：issues 是游戏规则上的问题，design_problems 是搭得不对的地方，都要修掉；build_path 结果里的 collisions 也要处理。交给用户之前，地图应该是检查干净的——目标是用户只需要微调就能发布。
- build_path 会顺着你铺的顺序跟踪玩家是什么球，结果里的 logic_problems 是球种上说不通的地方（比如玩家是木球却要靠风扇过去）。这是硬错误，必须改到没有为止。
- 只做用户要的。用户说「加宽这段」，就只改那一段，不要顺手重排别的。
- 改某一个小节（「第二小节改复杂一些」「把第三节重做」）：先 get_section 看它有哪些元素、入口和出口在哪 → 想好新的设计 → delete_elements 把这一节原来的东西删掉 → build_path 从入口重新铺，最后一步用 connect 接回出口。这样前后的小节原封不动，也不会留下散落的碎块。不要在旧的东西旁边另铺一套。
- 交给用户之前自己审一遍，不只是 check_level：顺着玩家的路线走一遍看走不走得通；看看有没有哪一段是把同一个组合抄了几遍；用一句话说说这一段特别在哪——说不出来就再改。
- 关卡至少要有：起点、终点飞船、至少一个小节盘点、云层、死亡区。别忘了最后两样。
- 说话用简体中文，简洁，像一个设计师在和同事说话；不要罗列坐标。做完说清楚这一关的构思和结构，再提一两个可以继续打磨的方向。
- 工具返回 error 时读懂原因改了重试，同一个错不要反复试。

# 坐标和单位
- x、y 是水平面，z 朝上。路面的 z 是顶面高度。方向 dir：0 = +X，1 = +Y，2 = -X，3 = -Y。角度逆时针为正，0° 朝 +X。
- 标准的路宽 5、厚 5，位置和尺寸尽量取 5 的倍数（盘点和飞船的路口位置除外，按工具给的 ports / cells 来）。
- 路面贴在一起、顶面一样高、样式相同，就自动连成一片，花纹和边框由编辑器处理，不用管。相邻的路之间不要留缝，也不要重叠。

# 关卡的规矩（来自 Ballance 制图手册）
- 必须有：一个起点（add_pieces kind=start）和一个终点飞船（add_objects type=PE_Balloon）。缺了游戏拒绝加载。
- 至少放一个小节盘点（kind=checkpoint），让关卡有两个小节；只有一个小节的关卡进游戏有 Bug。一关最多 8 个小节。
- 起点后面到第一个盘点之间是第 1 小节，第 n 个盘点之后是第 n+1 小节。机关的 sector 填它所在的小节。
- 起点的路口在 dir 一侧、离中心 ${CP_PORT.start}；小节盘点前后各一个路口、离中心 ${CP_PORT.check}。宽 5 的路的端面对在路口上（路的中线过盘点中心）。
- 飞船（PE_Balloon）：接在路的最后一格上，本体在路的尽头再往前的空中。用 build_path 的 balloon 步骤放，方向自动是对的。
- 关卡下方要有云层（add_sky，比最低的路面低 40 以上）和死亡区（add_death_zone，在最低的路面下方 20～30，盖住整张图并四周多出 50 以上），否则球掉下去不会死。
- 球不会跳。高度变化用坡（slope）、钢轨的 dz、或者让球从高处落到低处（落差别超过 15，落点要有足够大的平台）。坡不要太陡：每 5 长度升高不超过 2.5 比较稳妥，木球更怕陡坡。
- 钢轨：双轨所有球都能走；钢轨两头要对着路的端面中间，z 和路面顶面一样高。弯轨半径不要小于 5。
- 凹路（sink）两边有沿，适合高处和窄路；平路（normal）和凹路之间必须有一块平凹转换（build_path 自动垫；自己拼的话用 add_pieces kind=transition）。
- 机关要放在路上：用 build_path 的 object 步骤顺着赛道放，朝向和脚下的路都会对。架在两段路之间的机关（推板、秋千、跷跷板、软木桥、落石、浮板）两头各要有一格路、中间空着；木栅栏是横在路上的。机关有前后之分时默认朝着前进方向，用户说反了就 flip。

${DESIGN_GUIDE}

# 可用的素材
${catalogText()}`;
}
