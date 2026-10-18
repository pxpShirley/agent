/** 后端 API 封装 */
import type {
  ConversationRow,
  Portrait,
  SessionSummary,
  Stats,
  ChatMessage,
  AgentContext,
  AdminMemory,
  AdminReminder,
  AdminMood,
  ProactiveCard,
  SettingsView,
  SettingsUpdate,
  Model,
  PendingQuestion,
  AgentRun,
  NowData,
  Artifact,
  ArtifactVersion,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let finalUrl = url;
  // 后台受 ADMIN_TOKEN 保护时，自动附加本地存储的令牌（query 形式，兼容 SSE / GET / POST）
  if (finalUrl.startsWith('/api/admin')) {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') : null;
    if (token) {
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
  }
  const res = await fetch(finalUrl, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as any)?.error || `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ---- 客户侧 ----
  listSessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),
  getSession: (id: string) => request<{ session: SessionSummary; messages: ChatMessage[] }>(`/api/sessions/${id}`),
  deleteSession: (id: string) => request<{ success: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  /** 管家上下文：了解你 / 待办 / 情绪（跨会话聚合，真实读取 agent 记忆） */
  context: (owner = 'guest') => request<AgentContext>(`/api/context?owner=${encodeURIComponent(owner)}`),
  /** 主动卡片：管家主动推送的晨报 / 到期提醒 / 周复盘 */
  proactive: (owner = 'guest') => request<{ cards: ProactiveCard[] }>(`/api/proactive?owner=${encodeURIComponent(owner)}`),
  proactiveSeen: (id: string) => request<{ success: boolean }>(`/api/proactive/${id}/seen`, { method: 'POST' }),
  proactiveDismiss: (id: string) => request<{ success: boolean }>(`/api/proactive/${id}/dismiss`, { method: 'POST' }),
  /** 主动卡内联动作（A4）：执行服务端分支；客户端动作（ask_agent/open_view）返回 clientOnly 由前端处理 */
  proactiveAction: (id: string, type: string) =>
    request<{ ok: boolean; clientOnly?: boolean; error?: string }>(`/api/proactive/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ type }),
    }),
  adminProactive: () => request<{ cards: ProactiveCard[] }>('/api/admin/proactive'),

  // ---- 此刻主页 / 产物 ----
  /** 此刻主页聚合：主动事项 + 待你确认 + 进行中 + 建议 */
  now: (owner = 'guest') => request<NowData>(`/api/now?owner=${encodeURIComponent(owner)}`),
  /** 产物列表 */
  listArtifacts: (owner = 'guest') => request<{ artifacts: Artifact[] }>(`/api/artifacts?owner=${encodeURIComponent(owner)}`),
  getArtifact: (id: string) => request<{ artifact: Artifact }>(`/api/artifacts/${id}`),
  updateArtifact: (id: string, patch: { title?: string; content?: string; type?: string }) =>
    request<{ success: boolean }>(`/api/artifacts/${id}`, { method: 'POST', body: JSON.stringify(patch) }),
  /** 产物版本历史（新的在前） */
  listArtifactVersions: (id: string) => request<{ versions: ArtifactVersion[] }>(`/api/artifacts/${id}/versions`),
  /** 回滚到某个历史版本 */
  restoreArtifactVersion: (id: string, versionId: string) =>
    request<{ artifact: Artifact }>(`/api/artifacts/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    }),

  // ---- 管理后台 ----
  stats: (days = 14) => request<Stats>(`/api/admin/stats?days=${days}`),
  portrait: (days = 30) => request<Portrait>(`/api/admin/portrait?days=${days}`),
  activity: () => request<{ sessions: number; ts: number }>('/api/admin/activity'),
  conversations: (params: { keyword?: string; intent?: string; status?: string }) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v) acc[k] = v;
        return acc;
      }, {})
    ).toString();
    return request<{ conversations: ConversationRow[] }>(`/api/admin/conversations${qs ? `?${qs}` : ''}`);
  },
  conversationDetail: (id: string) =>
    request<{ session: SessionSummary; messages: ChatMessage[] }>(`/api/admin/conversations/${id}`),
  // 记忆治理（运营侧全量，取代知识库管理）
  adminMemories: () => request<{ memories: AdminMemory[] }>('/api/admin/memories'),
  adminReminders: () => request<{ reminders: AdminReminder[] }>('/api/admin/reminders'),
  adminMoods: () => request<{ moods: AdminMood[] }>('/api/admin/moods'),
  /** 指挥舱·活动流：agent 真实执行过的动作遥测 */
  adminRuns: () => request<{ runs: AgentRun[] }>('/api/admin/runs'),
  /** 指挥舱·例外收件箱：待人工确认的高风险动作 */
  adminPending: (owner?: string) =>
    request<{ questions: PendingQuestion[] }>(`/api/admin/pending${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
  /** 指挥舱·记忆即配置：直接教星澜记住一件事 */
  addMemory: (owner: string, kind: string, key: string, value: string) =>
    request<{ memory: AdminMemory }>('/api/admin/memories', {
      method: 'POST',
      body: JSON.stringify({ owner, kind, key, value }),
    }),
  deleteAdminMemory: (id: string) => request<{ success: boolean }>(`/api/admin/memories/${id}`, { method: 'DELETE' }),
  deleteAdminReminder: (id: string) => request<{ success: boolean }>(`/api/admin/reminders/${id}`, { method: 'DELETE' }),
  completeAdminReminder: (id: string) =>
    request<{ success: boolean }>(`/api/admin/reminders/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'complete' }) }),

  // ---- 用户自主管控（作用于当前 owner，无 admin 鉴权）----
  /** 编辑一条记忆：类目 / key / value / 过期时间（均可选，只传要改的字段） */
  updateMemory: (id: string, patch: { kind?: string; key?: string; value?: string; expire_at?: string | null }, owner = 'guest') =>
    request<{ memory: AgentContext['memories'][number] }>(`/api/memories/${id}?owner=${encodeURIComponent(owner)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** 删除一条记忆 */
  deleteMemory: (id: string, owner = 'guest') =>
    request<{ success: boolean }>(`/api/memories/${id}?owner=${encodeURIComponent(owner)}`, { method: 'DELETE' }),
  /** 合并主题重复的记忆：保留信息最完整的一条，删除其余 */
  mergeMemories: (ids: string[], owner = 'guest') =>
    request<{ memory: AgentContext['memories'][number]; removed: number }>(`/api/memories/merge?owner=${encodeURIComponent(owner)}`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  /** 清理当前 owner 已到期的记忆 */
  cleanupMemories: (owner = 'guest') =>
    request<{ success: boolean; removed: number }>(`/api/memories/cleanup?owner=${encodeURIComponent(owner)}`, {
      method: 'POST',
    }),
  /** 编辑一条待办：内容 / 到期时间（均可选） */
  updateReminder: (id: string, patch: { body?: string; due_at?: string | null }, owner = 'guest') =>
    request<{ reminder: AgentContext['reminders'][number] }>(`/api/reminders/${id}?owner=${encodeURIComponent(owner)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** 删除一条待办 */
  deleteReminder: (id: string, owner = 'guest') =>
    request<{ success: boolean }>(`/api/reminders/${id}?owner=${encodeURIComponent(owner)}`, { method: 'DELETE' }),
  /** 全量设置某待办的子步骤（text 列表，done 可选） */
  setReminderSteps: (id: string, steps: Array<{ text: string; done?: number }>, owner = 'guest') =>
    request<{ reminder: AgentContext['reminders'][number] }>(`/api/reminders/${id}/steps?owner=${encodeURIComponent(owner)}`, {
      method: 'PUT',
      body: JSON.stringify({ steps }),
    }),
  /** 勾选 / 取消某条子步骤（按 seq） */
  toggleReminderStep: (id: string, seq: number, done?: boolean, owner = 'guest') =>
    request<{ reminder: AgentContext['reminders'][number] }>(`/api/reminders/${id}/step/toggle?owner=${encodeURIComponent(owner)}`, {
      method: 'POST',
      body: JSON.stringify({ seq, done }),
    }),
  /** 完成 / 打卡一条提醒（周期提醒完成一期会自动生成下一期） */
  completeReminder: (id: string, owner = 'guest') =>
    request<{ success: boolean }>(`/api/reminders/${id}/complete?owner=${encodeURIComponent(owner)}`, {
      method: 'POST',
    }),
  reseed: (force: boolean) =>
    request<{ success: boolean; conversations: number }>('/api/admin/seed', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  // ---- 运行设置（自助配置凭证 / 演示模式 / 模型）----
  getSettings: () => request<SettingsView>('/api/settings'),
  updateSettings: (patch: SettingsUpdate) =>
    request<{ success: boolean; settings: SettingsView }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  /** 可用模型列表（真实引擎在线时返回实际可选模型） */
  models: () =>
    request<{ models: Model[]; defaultModel: string; provider: 'deepseek' | 'bailian'; providerLabel: string }>('/api/models'),
  /** 人在环：对待确认的高风险动作做决策（改后批准 / 转交人工 / 稍后处理 / 取消） */
  confirmQuestion: (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel', value?: string) =>
    request<{ ok: boolean; question: PendingQuestion; resolution: string; decision: string }>('/api/chat/confirm', {
      method: 'POST',
      body: JSON.stringify({ id, decision, value }),
    }),
};

export default api;
