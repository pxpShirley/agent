/** 全局类型定义 */

export type IntentCode = 'life' | 'schedule' | 'travel' | 'knowledge' | 'emotion' | 'other';
export type SessionStatus = 'bot' | 'closed';
export type Theme = 'light' | 'dark';

export interface Model {
  modelId: string;
  name: string;
  description?: string;
}

/** 凭证字段（脱敏只读，绝不回传明文） */
export interface CredentialView {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  set: boolean;
  preview?: string;
}

/** 运行设置视图（GET /api/settings） */
export interface SettingsView {
  credentials: CredentialView[];
  mockAgent: boolean;
  defaultModel: string;
  /** 百炼（通义千问 / DashScope）当前模型，配置的唯一真相源（BAILIAN_MODEL） */
  bailianModel: string;
  /** DeepSeek 当前模型，配置的唯一真相源（DEEPSEEK_MODEL） */
  deepseekModel: string;
  /** 当前实际生效的对话供应商 */
  chatProvider: 'deepseek' | 'bailian' | 'none';
  sdkActive: boolean;
  /** 本地音乐目录（空 = 未配置，回退系统「音乐」目录） */
  musicDir?: string;
  notes: string[];
}

/** 设置更新请求（POST /api/settings） */
export interface SettingsUpdate {
  /** 密钥明文；传空串表示清除 */
  credentials?: Record<string, string>;
  mockAgent?: boolean;
  defaultModel?: string;
  /** 百炼模型名（写入 BAILIAN_MODEL） */
  bailianModel?: string;
  /** DeepSeek 模型名（写入 DEEPSEEK_MODEL） */
  deepseekModel?: string;
  /** 本地音乐目录（写入 MUSIC_DIR）；空串表示回退到系统「音乐」目录 */
  musicDir?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string | null;
  intent?: IntentCode | null;
  intentLabel?: string | null;
  /** agent 模式：本轮管家实际调用过的工具名（如 save_memory / set_reminder） */
  tools?: string[];
  /** agent 模式：流式呈现的管家动作步骤（running → done） */
  steps?: AgentStep[];
  /** 人在环：本轮管家发起的待确认项（高风险动作前确认） */
  pendingQuestion?: PendingQuestion;
  /** 多 Agent 交付的结构化产物（行程卡 / 报告 / 清单） */
  artifacts?: Artifact[];
  /** 「空泛反问」护栏：当本回复被服务端替换成「推断 + 可点选选项」时，附带的选项按钮 */
  choices?: string[];
  createdAt: string;
  isStreaming?: boolean;
}

/** agent 模式：管家在回答过程中执行的真实动作（工具调用） */
export interface AgentStep {
  id: string;
  name: string;
  input?: unknown;
  status: 'running' | 'done';
  error?: boolean;
  /** 多 Agent：触发该动作的角色（planner/researcher/executor/critic） */
  role?: string;
}

/** 产物（Artifact）：Agent 交付的结构化、可编辑、可分享对象 */
export interface Artifact {
  id: string;
  owner: string;
  session_id: string | null;
  type: 'itinerary' | 'report' | 'checklist' | 'note';
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/** 产物历史版本（GET /api/artifacts/:id/versions） */
export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  title: string;
  content: string;
  type: string;
  created_at: string;
}

/** 此刻主页聚合数据（GET /api/now） */
export interface NowData {
  owner: string;
  proactive: ProactiveCard[];
  pending: PendingQuestion[];
  inProgress: AgentRun[];
  suggestions: string[];
}

/** 指挥舱·活动流：agent 一次自主/受控执行的遥测（字段与 DB 行列一致，snake_case） */
export interface AgentRun {
  id: string;
  session_id: string | null;
  prompt: string | null;
  intent: string | null;
  tools_used: string | null;
  outcome: string | null;
  model: string | null;
  created_at: string;
}

/** 人在环：待用户确认的高风险动作（ask_user 闭环） */
export interface PendingQuestion {
  id: string;
  sessionId: string;
  owner: string;
  question: string;
  options: string[] | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'escalated' | 'deferred';
  answer: string | null;
  createdAt: string;
  answeredAt?: string | null;
  /** 待确认动作的结构化描述（JSON 字符串），确认后由出站层真实执行 */
  actionJson?: string | null;
}

/** 待办子步骤（reminders.steps 内的 JSON 项） */
export interface ReminderStep {
  /** 稳定序号，从 0 递增，用于勾选/定位 */
  seq: number;
  text: string;
  /** 0 未完成 / 1 完成 */
  done: number;
}

/** 周期 / 习惯提醒规则（B2；与 server/recur.ts 的 RecurRule 同形，JSON 可往返） */
export interface RecurRule {
  freq: 'daily' | 'weekly' | 'monthly';
  at?: string;
  days?: number[];
  dom?: number;
  remaining?: number;
}

/** 管家上下文（GET /api/context）：跨会话聚合的记忆/待办/情绪 */
export interface AgentContext {
  owner: string;
  memories: Array<{ id: string; owner: string; kind: string; key: string; value: string; updated_at: string; expire_at: string | null }>;
  /** due_at = 人类可读原文（仅供展示）；due_ts = 归一化的 epoch ms（判定唯一依据，可空） */
  reminders: Array<{
    id: string;
    owner: string;
    due_at: string | null;
    due_ts: number | null;
    body: string;
    done: number;
    created_at: string;
    /** 子步骤清单（展示内容）；空数组表示未拆步骤 */
    steps: ReminderStep[];
    /** 周期/习惯规则（null=一次性）；非空表示这条提醒会按规则自动滚动下一期 */
    recur_rule: RecurRule | null;
  }>;
  moods: Array<{ id: string; owner: string; level: number; note: string; created_at: string }>;
}

/** 主动卡可内联触发的动作类型（A4） */
export type ProactiveActionType = 'complete' | 'snooze_hour' | 'snooze_day' | 'ask_agent' | 'open_view';

/** 单条内联动作（A4）：type 决定执行方，label 展示文案，payload 携带参数 */
export interface ProactiveAction {
  type: ProactiveActionType;
  label: string;
  payload?: { prompt?: string; view?: 'home' | 'dashboard' | 'governance' };
}

/** 主动卡片（scheduler 产出：晨报 / 到期提醒 / 周复盘） */
export interface ProactiveCard {
  id: string;
  owner: string;
  kind: 'morning' | 'reminder_due' | 'weekly' | 'nudge';
  title: string;
  body: string;
  status: 'pending' | 'seen' | 'dismissed';
  ref_id: string | null;
  due_at: string | null;
  created_at: string;
  /** 内联动作清单（A4）；空数组表示仅能已读/忽略 */
  actions: ProactiveAction[];
}

/** 记忆治理（运营侧，跨用户全量） */
export interface AdminMemory {
  id: string;
  owner: string;
  kind: string;
  key: string;
  value: string;
  updated_at: string;
}
export interface AdminReminder {
  id: string;
  owner: string;
  due_at: string | null;
  body: string;
  done: number;
  created_at: string;
}
export interface AdminMood {
  id: string;
  owner: string;
  level: number;
  note: string;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  customer_name: string;
  channel: string;
  status: SessionStatus;
  intent: IntentCode;
  resolved: number;
  created_at: string;
  updated_at: string;
  messageCount?: number;
  lastMessage?: string;
}

export interface ConversationRow extends SessionSummary {
  message_count: number;
  user_message_count: number;
  last_message: string | null;
}

export interface Stats {
  totals: {
    sessions: number;
    messages: number;
    userMessages: number;
    memoryCount: number;
    reminderCount: number;
    moodCount: number;
  };
  intentDistribution: Array<{ intent: string; count: number }>;
  hourlyEmotion: Array<{ hour: number; count: number }>;
  dailyTrend: Array<{ date: string; sessions: number }>;
}

export interface Portrait {
  summary: {
    totalSessions: number;
    activeUsers: number;
    emotionShare: number;
    returnUserRate: number;
  };
  topUsers: Array<{ name: string; sessions: number; topIntent: string }>;
  intentMix: Array<{ intent: string; count: number }>;
  emotionByHour: Array<{ hour: number; count: number }>;
}

export const INTENT_META: Record<IntentCode, { label: string; color: string; bg: string; icon: string }> = {
  life: { label: '生活百科', color: '#2dd4ee', bg: 'rgba(45,212,238,0.12)', icon: '✦' },
  schedule: { label: '日程规划', color: '#818cf8', bg: 'rgba(129,140,248,0.12)', icon: '◷' },
  travel: { label: '出行玩乐', color: '#c084fc', bg: 'rgba(192,132,252,0.12)', icon: '✈' },
  knowledge: { label: '知识解答', color: '#34d399', bg: 'rgba(52,211,153,0.12)', icon: '💡' },
  emotion: { label: '情感陪伴', color: '#f472b6', bg: 'rgba(244,114,182,0.12)', icon: '♡' },
  other: { label: '其他', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: '•' },
};

export const STATUS_META: Record<SessionStatus, { label: string; color: string; bg: string }> = {
  bot: { label: '智能服务中', color: '#2dd4ee', bg: 'rgba(45,212,238,0.12)' },
  closed: { label: '已结束', color: '#34d399', bg: 'rgba(52,211,153,0.10)' },
};
