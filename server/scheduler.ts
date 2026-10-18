/**
 * 星澜 · 主动调度器（Proactive Scheduler）
 * 让管家"不用你开口"也能办事：
 *   - 到期提醒：待办到点 → 生成 reminder_due 卡片
 *   - 每日晨报：每天一次，基于记忆/待办/心情生成当日简报
 *   - 每周复盘：每周五一次，温柔回顾本周
 * 有真实大模型凭证且开启 AGENT_BRIEFING=1 时，晨报/周复盘由真实模型生成；
 * 否则用模板生成（默认，保证可见可测）。
 */
import * as db from './db.js';
import type { ProactiveAction } from './db/proactive.js';
import { runBailianAgentTurn } from './llm/bailian.js';
import { isCompatEngineConfigured } from './settings.js';
import { notifyChanged } from './realtime.js';
import type { ReminderRecord } from './db.js';

/** 真实大模型是否可用（CodeBuddy SDK 分支已于 2026-10-06 移除） */
function engineConfigured(): boolean {
  return isCompatEngineConfigured();
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function startOfWeekIso(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // 距本周一
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---- 模板生成（无 SDK 时默认路径）----

/**
 * 从用户记忆里挑最适合写进晨报/复盘的（最多 2 条，保持简报不啰嗦）：
 * 优先「目标/计划」(用户当前关心) → 「偏好」(被记住的感觉) → 任一条。
 * 让主动服务真正"基于你"，而不是永远只念第一条。
 */
function pickBriefMemories(owner: string, max = 2): Array<{ key: string; value: string }> {
  const mems = db.getMemories(owner, 50);
  if (!mems.length) return [];
  const plan = mems.find((m) => m.kind === 'plan' || /目标|计划|这周|本周|想做|推进/.test(m.key + m.value));
  const pref = mems.find((m) => m.kind === 'preference' || /偏好|喜欢|习惯|讨厌|忌|作息|沟通/.test(m.key + m.value));
  const picked: Array<{ key: string; value: string }> = [];
  for (const m of [plan, pref, mems[0]]) {
    if (!m) continue;
    if (picked.some((p) => p.key === m.key && p.value === m.value)) continue; // 去重
    picked.push({ key: m.key, value: m.value });
    if (picked.length >= max) break;
  }
  return picked;
}

/** 解析用户的「免打扰时段」记忆（如"晚上11点后少打扰"）→ 小时窗口；无则返回 null */
export interface QuietWindow { start: number; end: number }
export function detectQuietHours(owner: string): QuietWindow | null {
  const mems = db.getMemories(owner, 50);
  for (const m of mems) {
    const text = `${m.key} ${m.value}`;
    if (!/(少打扰|不打扰|免打扰|别打扰|勿扰|安静)/.test(text)) continue;
    const hourMatch = text.match(/(\d{1,2})\s*[:：]?\s*点|(\d{1,2})\s*[:：]\s*\d{2}/);
    if (!hourMatch) continue;
    let h = parseInt(hourMatch[1] || hourMatch[2], 10);
    if (isNaN(h) || h < 0 || h > 23) continue;
    // 12 小时制换算：晚上/夜里/半夜/下午/傍晚 → +12；凌晨 12 点视为 0
    if (/晚上|夜里|夜晚|半夜|深夜|午夜|下半夜|后半夜/.test(text)) {
      if (h < 12) h += 12;
    } else if (/下午|傍晚/.test(text)) {
      if (h < 12) h += 12;
    } else if (/凌晨|清晨|拂晓/.test(text)) {
      if (h === 12) h = 0;
    }
    // "后/之后" → 从该小时覆盖到次日清晨；否则默认前后各 2 小时小窗口
    if (/后|之后|以后/.test(text)) return { start: h, end: (h + 8) % 24 };
    return { start: (h + 22) % 24, end: (h + 2) % 24 };
  }
  return null;
}

/** 当前是否处于免打扰窗口（hour 可注入以便测试） */
export function isQuietNow(qh: QuietWindow | null, hour = new Date().getHours()): boolean {
  if (!qh) return false;
  if (qh.start <= qh.end) return hour >= qh.start && hour <= qh.end;
  return hour >= qh.start || hour <= qh.end; // 跨午夜
}

function buildMorning(owner: string): { title: string; body: string } {
  const pending = db.listReminders(owner, false);
  const dueSoon = pending.filter((r) => r.due_ts !== null && r.due_ts <= Date.now() + 2 * 86400000);
  const moods = db.recentMoods(owner, 7);
  const lastMood = moods[0];
  const mems = pickBriefMemories(owner);
  const fb = db.summarizeFeedback(owner);

  const lines: string[] = [];
  if (dueSoon.length) {
    lines.push(`· 接下来有 ${dueSoon.length} 件事要盯：${dueSoon[0].body}${dueSoon.length > 1 ? ' 等' : ''}`);
  } else if (pending.length) {
    lines.push(`· 你有 ${pending.length} 件待办，暂时都不急`);
  } else {
    lines.push('· 近期没有紧迫待办，节奏可以松一点');
  }
  if (lastMood) {
    const tone =
      lastMood.level <= 2
        ? '最近你状态有点低，今天我多陪你一会儿'
        : lastMood.level >= 4
        ? '看你最近状态不错，保持住'
        : '最近情绪平稳，挺好的';
    lines.push(`· ${tone}`);
  }
  for (const mem of mems) {
    lines.push(`· 按你的情况，我记着：${mem.key ? `${mem.key} → ` : ''}${mem.value}`);
  }
  if (fb) lines.push(`· ${fb}`);
  lines.push('今天想让我帮你做点什么？规划、提醒、陪聊，都可以开口。');
  return { title: '今日晨报', body: lines.join('\n') };
}

function buildWeekly(owner: string): { title: string; body: string } {
  const pending = db.listReminders(owner, false);
  const moods = db.recentMoods(owner, 7);
  const avg = moods.length ? moods.reduce((s, m) => s + m.level, 0) / moods.length : null;
  const memories = db.getMemories(owner, 50);
  const mems = pickBriefMemories(owner);
  const fb = db.summarizeFeedback(owner);
  const lines: string[] = [];
  lines.push(`· 本周还有 ${pending.length} 件待办没清零`);
  if (avg !== null) lines.push(`· 本周情绪均值 ${avg.toFixed(1)} / 5`);
  lines.push(`· 我们已经一起攒下 ${memories.length} 条关于你的记忆`);
  for (const mem of mems) {
    lines.push(`· 你之前提过：${mem.key ? `${mem.key} → ` : ''}${mem.value}`);
  }
  if (fb) lines.push(`· ${fb}`);
  lines.push('新的一周，想先搞定哪件事？我可以帮你把它拆开。');
  return { title: '本周复盘', body: lines.join('\n') };
}

function buildReminderCard(r: ReminderRecord): { title: string; body: string } {
  // 用结构化的 due_ts 渲染；due_at 是自由文本原文，直接 new Date() 会得到 Invalid Date
  const due =
    r.due_ts !== null
      ? new Date(r.due_ts).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : r.due_at || '未设具体时间';
  return {
    title: `提醒到了：${r.body}`,
    body: `原定 ${due}。需要我现在帮你处理，还是顺延几天？`,
  };
}

// 优先用 agent 生成，失败回退模板
async function maybeAgent(
  owner: string,
  kind: 'morning' | 'weekly',
  fallback: () => { title: string; body: string }
): Promise<{ title: string; body: string }> {
  const base = fallback();
  if (process.env.AGENT_BRIEFING === '1' && engineConfigured()) {
    try {
      const prompt =
        kind === 'morning'
          ? `你是 AI 生活管家「星澜」。为老用户「${owner}」写一段今日晨报：亲切、简洁（3-5 句）、中文，基于你已知的记忆与待办，不要编造未记录的信息。`
          : `你是 AI 生活管家「星澜」。为老用户「${owner}」写一段本周复盘：温柔、有行动建议、中文、3-5 句，不要编造未记录的信息。`;
      let text = '';
      const gen = runBailianAgentTurn({
        sessionId: `sched-${owner}-${kind}-${Date.now()}`,
        message: prompt,
        customerName: owner,
        intent: 'other',
        omitTools: ['web_lookup'], // 晨报/复盘只基于库内记忆，不联网
      });
      for await (const ev of gen) {
        if (ev.type === 'text') text += ev.content;
      }
      if (text.trim()) return { title: base.title, body: text.trim() };
    } catch {
      /* 回退模板 */
    }
  }
  return base;
}

/**
 * 需要主动服务的 owner 列表。
 * 早期直接取 `db.distinctOwners()`（sessions 里出现过的所有 customer_name），
 * 结果演示客户（何川/叶桐/周野…）各生成一张晨报，把卡片池冲爆、真正的用户反而被淹没。
 * 改为：只服务近期活跃且有实际数据（记忆/待办/会话）的 owner，并设上限。
 */
const MAX_PROACTIVE_OWNERS = 5;

function activeOwners(): string[] {
  const all = db.distinctOwners();
  const scored = all
    .map((owner) => {
      let score = 0;
      try {
        score += db.getMemories(owner, 50).length * 3;
        score += db.listReminders(owner, false).length * 2;
      } catch {
        /* 查询失败按 0 分处理 */
      }
      return { owner, score };
    })
    .filter((x) => x.score > 0) // 没有任何记忆与待办的用户不推送，避免空泛打扰
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROACTIVE_OWNERS);
  return scored.map((x) => x.owner);
}

async function tick(): Promise<void> {
  const owners = activeOwners();
  const hour = new Date().getHours();
  const day = new Date().getDay(); // 5 = 周五
  for (const owner of owners) {
    // 免打扰时段：跳过晨报/周复盘等非紧急主动推送（到期提醒是用户自己设的硬截止，仍照常）
    const quiet = isQuietNow(detectQuietHours(owner));
    // 1) 到期提醒
    for (const r of db.listDueReminders(owner)) {
      if (!db.proactiveCardExists(owner, 'reminder_due', r.id)) {
        const c = buildReminderCard(r);
        const actions: ProactiveAction[] = [
          { type: 'complete', label: '完成打卡' },
          { type: 'snooze_hour', label: '顺延1小时' },
          { type: 'snooze_day', label: '顺延1天' },
          { type: 'ask_agent', label: '一键问栖光', payload: { prompt: `帮我看看「${r.body}」现在该怎么处理` } },
          { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
        ];
        db.addProactiveCard({
          owner,
          kind: 'reminder_due',
          title: c.title,
          body: c.body,
          ref_id: r.id,
          due_at: r.due_at,
          actions,
        });
      }
    }
    // 2) 每日晨报（6 点后、当天未生成、且非免打扰时段）
    if (!quiet && hour >= 6 && !db.proactiveCardExistsSince(owner, 'morning', startOfTodayIso())) {
      const c = await maybeAgent(owner, 'morning', () => buildMorning(owner));
      const actions: ProactiveAction[] = [
        { type: 'ask_agent', label: '一键问栖光', payload: { prompt: '今天有什么要我帮忙安排的？' } },
        { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
      ];
      db.addProactiveCard({ owner, kind: 'morning', title: c.title, body: c.body, actions });
    }
    // 3) 每周复盘（周五 18 点后、本周未生成、且非免打扰时段）
    if (!quiet && day === 5 && hour >= 18 && !db.proactiveCardExistsSince(owner, 'weekly', startOfWeekIso())) {
      const c = await maybeAgent(owner, 'weekly', () => buildWeekly(owner));
      const actions: ProactiveAction[] = [
        { type: 'ask_agent', label: '一键问栖光', payload: { prompt: '新的一周，先帮我搞定哪件事？' } },
        { type: 'open_view', label: '跳转视图', payload: { view: 'dashboard' } },
      ];
      db.addProactiveCard({ owner, kind: 'weekly', title: c.title, body: c.body, actions });
    }
  }
}

// 演示态：为 guest 预置少量记忆与一条待到期提醒，让主动能力可见可测。
// 默认**关闭**（DEMO_SEED=1 才开启）：演示数据会被模型当成用户真实信息复述
// （曾出现把假待办「交水电费」、假偏好「11 点后少打扰」念给用户的情况），
// 真实使用必须保持关闭，让记忆与待办完全由用户自己产生。
function ensureDemoSeed(): void {
  if (!/^(1|true|yes)$/i.test(process.env.DEMO_SEED || '')) return;
  const owner = 'guest';
  if (db.getMemories(owner, 1).length === 0) {
    db.saveMemory(owner, 'preference', '作息', '习惯晚上 11 点后少打扰（示例）');
    db.saveMemory(owner, 'preference', '沟通', '喜欢先给结论，不喜欢被反复追问（示例）');
  }
  // 只要用户已有任何未完成的提醒就不再补演示数据，避免演示内容混进真实待办
  if (db.listReminders(owner, false).length === 0) {
    // 标题带（示例）便于一眼区分；时间给 2 小时后，避免「一启动就已过期」
    db.addReminder(owner, '交水电费（示例）', new Date(Date.now() + 2 * 3600000).toISOString());
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler(intervalMs = 60000): void {
  ensureDemoSeed();
  tick().catch((e) => console.error('[Scheduler] 首次 tick 出错：', e));
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((e) => console.error('[Scheduler] tick 出错：', e));
  }, intervalMs);
  console.log(`[Scheduler] 主动调度已启动（间隔 ${intervalMs / 1000}s）`);
}

/** 手动触发（管理后台「立即跑一轮」用） */
export async function runSchedulerNow(): Promise<{ owners: number; ok: boolean }> {
  const owners = db.distinctOwners();
  await tick();
  notifyChanged();
  return { owners: owners.length, ok: true };
}
