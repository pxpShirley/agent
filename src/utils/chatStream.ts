/**
 * 对话流式的**纯函数**层
 *
 * 从 `hooks/useServiceChat.ts` 那个 408 行的 send() 里抽出来的部分。
 * 以前这些逻辑埋在闭包里，改一行要读完整段、且完全无法单测；
 * 现在它们是纯函数（输入 → 输出，无副作用），可以被回归测试直接覆盖。
 */
import type { AgentStep, IntentCode, PendingQuestion, Artifact, ChatMessage } from '../types';
import { INTENT_META } from '../types';

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** SSE 事件（后端 /api/chat 推送的原始帧） */
export type ChatEvent = {
  type: 'init' | 'text' | 'tool' | 'tool_result' | 'artifact' | 'notice' | 'ask_user' | 'music' | 'done';
  [k: string]: any;
};

/**
 * 增量解析 SSE 字节流。
 * 网络分片不保证按帧边界到达，所以必须把没拼完整的半帧留在 buffer 里等下一片。
 * @returns 本次新解析出的完整事件 + 未拼完的残留（要喂给下一次调用）
 */
export function parseSseChunk(chunk: string, buffer: string): { events: ChatEvent[]; buffer: string } {
  const parts = (buffer + chunk).split('\n\n');
  const rest = parts.pop() || '';
  const events: ChatEvent[] = [];
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as ChatEvent);
    } catch {
      /* 坏帧忽略，不打断整条流 */
    }
  }
  return { events, buffer: rest };
}

/**
 * 工具结果落到步骤流上：优先匹配「最早一个仍在 running 的同名步骤」。
 * 同一工具可能被调多次，先进先出才对；找不到同名再回退到最早一个 running。
 * （旧实现用 lastIndexOf('running')，多工具并发时会把结果记到另一个工具头上。）
 */
export function applyStepResult(steps: AgentStep[], name: string, ok: boolean): AgentStep[] {
  let idx = steps.findIndex((s) => s.status === 'running' && s.name === name);
  if (idx === -1) idx = steps.findIndex((s) => s.status === 'running');
  if (idx === -1) return steps;
  return steps.map((s, i) => (i === idx ? { ...s, status: 'done', error: !ok } : s));
}

/**
 * 收尾所有仍在 running 的步骤。
 * 必须在「流结束」时调用：否则没有 tool_result 的工具（如 ask_user 人在环）
 * 或被中断的工具会让思维流永远停在「执行中 …」。
 */
export function settleSteps(steps: AgentStep[], markError = false): AgentStep[] {
  return steps.map((s) => (s.status === 'running' ? { ...s, status: 'done', error: markError } : s));
}

/** 四种决策 → 待确认项状态 */
export function decisionToStatus(
  decision: 'approve' | 'escalate' | 'defer' | 'cancel'
): PendingQuestion['status'] {
  return decision === 'approve'
    ? 'confirmed'
    : decision === 'escalate'
      ? 'escalated'
      : decision === 'defer'
        ? 'deferred'
        : 'cancelled';
}

export function intentLabelOf(code: IntentCode): string {
  return INTENT_META[code]?.label || '其他';
}

/** 由 artifact 事件构造前端产物对象（内容待拉取，先占位） */
export function artifactFromEvent(data: ChatEvent, sessionId: string | null): Artifact {
  return {
    id: data.id,
    owner: 'guest',
    session_id: sessionId,
    type: (data.artifactType || 'note') as Artifact['type'],
    title: data.title || '未命名产物',
    content: '',
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * 由 ask_user 事件构造待确认卡。
 * options 在协议里可能已是数组，也可能是逗号分隔字符串——统一归一成数组，
 * 让 `PendingQuestion.options: string[] | null` 这个类型声明不再说谎。
 */
export function pendingFromEvent(data: ChatEvent, sessionId: string | null): PendingQuestion {
  return {
    id: data.id,
    sessionId: data.sessionId || sessionId || '',
    owner: data.owner || 'guest',
    question: data.question,
    options: normalizeOptions(data.options),
    status: 'pending',
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    actionJson: data.action_json || null,
  };
}

function normalizeOptions(v: unknown): string[] | null {
  if (!v) return null;
  if (Array.isArray(v)) {
    const arr = v.map((s) => String(s).trim()).filter(Boolean);
    return arr.length ? arr : null;
  }
  const arr = String(v)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : null;
}

/** 只把 patch 应用到指定 id 的那条消息上（不改其它消息，避免整表重渲染） */
export function patchMessage(
  messages: ChatMessage[],
  id: string,
  patch: Partial<ChatMessage>
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
}
