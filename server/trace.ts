/**
 * 回放级 trace 的采集器与摘要助手（P0·2026-10-25）
 *
 * 设计要点：
 * - SpanCollector 在一次对话轮内累积 span，轮末一次性 flush 进 agent_spans 表。
 *   runId 为空（skipRecord）时 flush 静默丢弃，绝不落库。
 * - 摘要助手负责把工具入参 / 返回 / 思考文本截断到安全长度，
 *   避免把大对象（如整段网页、长记忆）灌进 trace 表撑爆体积。
 * - 这是「只读观测」层：span 只入库，绝不回灌模型上下文（见 MEMORY.md §九 trace 红线）。
 */
import { addAgentSpans, type SpanInput, type SpanPhase } from './db/ops.js';

/** span 文本安全上限：思考/错误/确认文本过长截断 */
const TEXT_MAX = 1000;
/** 工具入参 / 返回摘要安全上限 */
const JSON_MAX = 2000;

/** 把任意值转成「可入库的摘要文本」：对象→JSON（截断），字符串→原样（截断），其余→String */
export function summarizeJson(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined || s === null) return null;
  return s.length > JSON_MAX ? s.slice(0, JSON_MAX) + '…' : s;
}

/** 把可见文本截断到安全长度（空值返回 null，便于入库时存 NULL 而非空串） */
export function summarizeText(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '…' : s;
}

/** 一次对话轮的 span 采集器 */
export class SpanCollector {
  private spans: SpanInput[] = [];

  /** 追加一个 span（按 push 顺序决定 seq） */
  push(span: SpanInput): void {
    this.spans.push(span);
  }

  /** 便捷：追加一条 think 思考 span */
  think(text: string): void {
    const t = summarizeText(text);
    if (t) this.spans.push({ phase: 'think', text: t });
  }

  /** 便捷：追加一条 intent 标注 span */
  intent(phase: SpanPhase, text: string): void {
    const t = summarizeText(text);
    if (t) this.spans.push({ phase, text: t });
  }

  /** 已累积的 span 数量 */
  get size(): number {
    return this.spans.length;
  }

  /** 落库并清空。runId 为空（skipRecord）时静默丢弃累积的 span。 */
  flush(runId: string): void {
    if (!runId) {
      this.spans = [];
      return;
    }
    const batch = this.spans;
    this.spans = [];
    try {
      addAgentSpans(runId, batch);
    } catch {
      /* 遥测失败不影响主流程 */
    }
  }
}
