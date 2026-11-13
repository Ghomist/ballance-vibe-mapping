// 和大模型对话：OpenAI 兼容的 chat/completions 接口（DeepSeek、OpenAI、通义、智谱、本地的 Ollama 等都是这个格式），
// 流式返回，边收边把文字交给界面；工具调用攒齐了再一起返回。
// 浏览器直接连服务商：API Key 只在请求头里发给用户自己填的那个地址，不经过别的服务器。

export interface ToolCall { id: string; name: string; arguments: string }
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface LlmConfig { base: string; model: string; key: string }
export interface LlmReply { content: string; calls: ToolCall[] }
export type Llm = (messages: ChatMsg[], tools: unknown[], opt: { signal?: AbortSignal; onText?: (delta: string) => void }) => Promise<LlmReply>;

/** 常见的服务商；base 是到 /v1 为止（不带 /chat/completions） */
export const PROVIDERS: { id: string; label: string; base: string; model: string; keyUrl?: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4.1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', base: '', model: '' },
];

/** 服务商返回的错误，翻成能看懂的话 */
function explain(status: number, body: string): string {
  let msg = '';
  try { const j = JSON.parse(body); msg = j?.error?.message ?? j?.message ?? ''; } catch { msg = body.slice(0, 200); }
  if (status === 401 || status === 403) return `API Key 不对或者没有权限（${status}）${msg ? `：${msg}` : ''}`;
  if (status === 402) return `账户余额不足（402）${msg ? `：${msg}` : ''}`;
  if (status === 404) return `地址或模型名不对（404）${msg ? `：${msg}` : ''}`;
  if (status === 429) return `请求太频繁，或者额度用完了（429）${msg ? `：${msg}` : ''}`;
  if (status >= 500) return `服务商那边出错了（${status}），稍后再试${msg ? `：${msg}` : ''}`;
  return `请求失败（${status}）${msg ? `：${msg}` : ''}`;
}

/** 解析流式返回的一行行 data: {...}，把增量交给 onDelta */
export async function readSse(body: ReadableStream<Uint8Array>, onDelta: (d: Record<string, unknown>) => void) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '';
  const line = (l: string) => {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j: { choices?: { delta?: Record<string, unknown> }[]; error?: { message?: string } };
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(j.error.message ?? '服务商返回了错误');
    const d = j.choices?.[0]?.delta;
    if (d) onDelta(d);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf) line(buf);
}

export function makeLlm(cfg: LlmConfig, fetchFn: typeof fetch = fetch): Llm {
  return async (messages, tools, { signal, onText }) => {
    const url = `${cfg.base.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: 'auto', stream: true, temperature: 0.8 }),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new Error(`连不上 ${new URL(url).host}：检查网络和接口地址；有的服务商不允许网页直接访问（跨域限制），那就用不了`);
    }
    if (!res.ok) throw new Error(explain(res.status, await res.text().catch(() => '')));
    if (!res.body) throw new Error('服务商没有返回内容');
    let content = '';
    const calls: ToolCall[] = [];
    await readSse(res.body, (d) => {
      if (typeof d.content === 'string' && d.content) { content += d.content; onText?.(d.content); }
      // 工具调用是一小段一小段来的：按 index 攒起来
      for (const tc of (d.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', name: '', arguments: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
    });
    return { content, calls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })) };
  };
}
