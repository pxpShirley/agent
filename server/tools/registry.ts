/**
 * 星澜 · 工具注册表（**唯一**一份）
 *
 * 这个文件的存在理由：以前工具定义有两份——
 *   · server/tools/index.ts：MCP 式定义，随执行通道切换到 OpenAI 兼容协议后成了死代码；
 *   · server/llm/bailian.ts execTool()：真正跑的那份（手写 switch 镜像实现）。
 * 两处维护必然漂移，最严重的一次是系统提示词的能力清单取自死的那份，
 * 导致 open/create/update_artifact 三个产物工具落在「清单之外」而被模型自我禁止调用。
 *
 * 现在 schema 与 handler 同处定义，新增工具**只改这一个文件**：
 *   · 下发给模型的 schema：activeToolDefs()
 *   · 实际执行：execTool()
 *   · 提示词里的能力清单：由 activeToolDefs() 派生（见 agent.ts buildSystemPrompt 的必传参数）
 * 三者天然同源，不可能再出现「提示词说的」和「实际给的」不一致。
 */
import * as db from '../db.js';
import type { IntentCode } from '../db.js';
import { webSearch, isWebSearchConfigured } from './web.js';
import { syncReminder } from '../actions/outbound.js';
import { humanizeRecur, type RecurRule } from '../recur.js';
import { setMusicAction } from '../music.js';
import { selectMemories, formatMemoryLine } from '../memory.js';

export interface ToolContext {
  owner: string;
  sessionId: string;
  intent: IntentCode;
}

export interface ToolArg {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  /** 数组元素类型（仅 type==='array' 时有效） */
  items?: { type: ToolArg['type']; description?: string };
  /** 对象类型（仅 type==='object' 时有效）：嵌套属性定义 */
  properties?: Record<string, ToolArg>;
  required?: string[];
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, ToolArg>;
  required: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** 动态启用条件：不传即常驻。缺凭证/无依赖时不注入 schema，省上下文 */
  enabled?: (ctx: ToolContext) => boolean;
  /** 单工具超时（ms），默认 15000 */
  timeoutMs?: number;
  /** 失败重试次数，默认 2（即最多执行 3 次） */
  retries?: number;
  /** 返回给模型的文本结果 */
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
}

// ----------------------------------------------------------------
// 十个工具：schema 与实现写在一起
// ----------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'recall_memory',
    description:
      '回看关于该用户的长期记忆（偏好/习惯/计划/约定）。**仅当你需要系统提示词「关于这位用户」之外的更多记忆时才调用**——那里已列出的不要重复查。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查找的主题关键词，如「偏好」「作息」「计划」' } },
      required: ['query'],
    },
    run: (args, ctx) => {
      // 与 buildMemoryContext 共用 server/memory.ts 的打分/选取，
      // 保证「预注入看到的」和「主动回看看到的」排序一致（曾经两处各写一份，会漂移）。
      // 工具路径是显式查，单条截断放宽到 400 字符（注入路径是 160）。
      const rows = db.getMemories(ctx.owner, 60);
      const list = selectMemories(rows, String(args?.query || ''), { snippetMax: 400 });
      return list.length ? list.map((r) => formatMemoryLine(r, 400)).join('\n') : '（暂无相关记忆）';
    },
  },
  {
    name: 'save_memory',
    description: '记住关于该用户的一件事（偏好/习惯/计划/约定/关键事实），供以后对话使用。学到新信息时调用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '记忆类型', enum: ['fact', 'preference', 'plan', 'note'] },
        key: { type: 'string', description: '简短键名，如「作息」「城市」「本周目标」' },
        value: { type: 'string', description: '具体内容' },
      },
      required: ['kind', 'key', 'value'],
    },
    run: (args, ctx) => {
      const kind = String(args?.kind || 'note');
      const key = String(args?.key || '关键信息');
      const value = String(args?.value || '');
      db.saveMemory(ctx.owner, kind, key, value);
      return `已记住：${key} = ${value}`;
    },
  },
  {
    name: 'checkin_mood',
    description: '记录用户当前情绪（1-5，5 最好）。当用户倾诉、情绪低落或主动表达感受时调用。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'integer', description: '情绪分值 1(很差)~5(很好)' },
        note: { type: 'string', description: '简短情绪备注，可空' },
      },
      required: ['level'],
    },
    run: (args, ctx) => {
      const level = Math.max(1, Math.min(5, Number(args?.level ?? 3)));
      db.addMood(ctx.owner, level, String(args?.note || ''));
      return `已记录今日情绪：${level}/5`;
    },
  },
  {
    name: 'set_reminder',
    description:
      '为用户设置提醒或待办。用户说"提醒我/记一下/帮我设个/把这件事拆成几步/以后每天提醒我喝水"时调用。可附带 steps 把待办拆成可勾选的若干子步骤；想设周期/习惯提醒就传 recur（每天/每周几/每月几号循环，完成一期自动排下一期）。',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', description: '提醒内容' },
        when: { type: 'string', description: '一次性提醒的时间描述，如「明天 9 点」；设了 recur 时可留空' },
        steps: {
          type: 'array',
          description: '可选子步骤清单，如 ["订机票","订酒店","排行程"]；给了就拆成可勾选步骤并展示进度',
          items: { type: 'string' },
        },
        recur: {
          type: 'object',
          description:
            '可选·周期/习惯提醒。结构：{ freq: "daily"|"weekly"|"monthly", at?: "HH:MM"(默认09:00), days?: number[](weekly用,0=周日…6=周六), dom?: number(monthly用,1-31), count?: number(限定总次数,到点自动停止) }。例：每天22点喝水→{freq:"daily",at:"22:00"}；每周一三五晨跑→{freq:"weekly",days:[1,3,5],at:"08:00"}；每月1号交租→{freq:"monthly",dom:1,at:"09:00"}；21天打卡→{freq:"daily",count:21}。',
          properties: {
            freq: { type: 'string', description: '重复频率', enum: ['daily', 'weekly', 'monthly'] },
            at: { type: 'string', description: '每天/每周的触发时刻 "HH:MM"，如 "22:00"，默认 09:00' },
            days: {
              type: 'array',
              description: 'weekly 用：星期几数组，0=周日…6=周六，如 [1,3,5]',
              items: { type: 'integer' },
            },
            dom: { type: 'integer', description: 'monthly 用：每月几号，1-31' },
            count: { type: 'integer', description: '限定总次数，到点后自动停止（如 21 天打卡挑战）' },
          },
          required: ['freq'],
        },
      },
      required: ['what'],
    },
    run: (args, ctx) => {
      const what = String(args?.what || '');
      const when = args?.when ? String(args.when) : null;
      const stepsRaw = Array.isArray(args?.steps) ? (args.steps as unknown[]).map((s) => String(s)) : [];

      // 周期/习惯：把模型给的对象收成结构化 RecurRule（自由文本不进判定链路）
      let recur: RecurRule | null = null;
      const r = args?.recur;
      if (r && typeof r === 'object') {
        const freq = String((r as any).freq || '');
        if (freq === 'daily' || freq === 'weekly' || freq === 'monthly') {
          recur = { freq } as RecurRule;
          const at = (r as any).at;
          if (typeof at === 'string' && /^(\d{1,2}):(\d{2})$/.test(at.trim())) recur.at = at.trim();
          if (freq === 'weekly' && Array.isArray((r as any).days)) {
            const rawDays = ((r as any).days as unknown[])
              .map((d) => Number(d))
              .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
            if (rawDays.length) recur.days = Array.from(new Set(rawDays)).sort((a, b) => a - b);
          }
          if (freq === 'monthly' && Number.isInteger((r as any).dom)) {
            const dom = Math.min(31, Math.max(1, (r as any).dom));
            if (dom >= 1) recur.dom = dom;
          }
          // count 直接透传；count→remaining 的归一化在 addReminder（存储层唯一换算点）完成
          if (typeof (r as any).count === 'number' && (r as any).count > 0) recur.count = (r as any).count;
        }
      }

      const r0 = db.addReminder(
        ctx.owner,
        what,
        recur ? null : when,
        stepsRaw.map((s) => ({ text: s })),
        recur,
      );
      // 打通：若配置了出站通道，最佳努力把提醒同步到外部（失败静默）
      void syncReminder(what, recur ? null : when, ctx.owner);

      let tail = '';
      if (recur) tail = `（${humanizeRecur(recur)}，已自动排好后续）`;
      else if (when) tail = `（${when}）`;
      const stepInfo = r0.steps.length ? `，已拆成 ${r0.steps.length} 个子步骤` : '';
      const recurInfo = r0.recur_rule ? `，按「${humanizeRecur(r0.recur_rule)}」循环` : '';
      return r0.deduped
        ? `这条已经记过了：${what}${tail}。与现有提醒重复，未重复添加。`
        : `已记下提醒：${what}${tail}${stepInfo}${recurInfo}`;
    },
  },
  {
    name: 'check_reminder_step',
    description:
      '勾选/取消某条待办里的某个子步骤。用户说"XX 做完了/把第 2 步勾掉"或模型推进待办时调用。全部子步骤完成时整条待办自动标记完成。可凭 reminder_id 或 what(内容关键词) 定位待办，凭 step_text 或 step_seq 定位子步骤。',
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: '待办 id（优先）' },
        what: { type: 'string', description: '待办内容关键词，用于在没 id 时定位' },
        step_text: { type: 'string', description: '要勾选的子步骤文字（模糊匹配）' },
        step_seq: { type: 'integer', description: '要勾选的子步骤序号（从 0 起），有则优先于 step_text' },
        done: { type: 'integer', description: '1=标记为完成, 0=取消完成；不传则翻转当前状态' },
      },
      required: [],
    },
    run: (args, ctx) => {
      const id = args?.reminder_id ? String(args.reminder_id) : '';
      let rem: ReturnType<typeof db.getReminderById> | undefined = id ? db.getReminderById(id) : undefined;
      if (!rem && args?.what) {
        const q = String(args.what)
          .replace(/[\s\u3000]+/g, '')
          .replace(/[，。、！？,.!?~～·:：;；'"“”‘’()（）\-—_/\\]/g, '')
          .toLowerCase();
        rem = db.listReminders(ctx.owner, true).find((r) => {
          const rb = String(r.body)
            .replace(/[\s\u3000]+/g, '')
            .replace(/[，。、！？,.!?~～·:：;；'"“”‘’()（）\-—_/\\]/g, '')
            .toLowerCase();
          return rb.includes(q) || q.includes(rb);
        });
      }
      if (!rem) return '没找到对应的待办，请确认内容或先创建它。';
      const steps = rem.steps;
      if (!steps.length) return `这条待办还没有子步骤，无法勾选。可先说「把《${rem.body}》拆成几步」。`;
      let target = -1;
      if (typeof args?.step_seq === 'number') {
        target = steps.findIndex((s) => s.seq === args.step_seq);
      } else if (args?.step_text) {
        const q = String(args.step_text).trim().toLowerCase();
        target = steps.findIndex((s) => s.text.toLowerCase().includes(q) || q.includes(s.text.toLowerCase()));
      }
      if (target < 0) return `没找到对应的子步骤。当前子步骤：${steps.map((s, i) => `${i}. ${s.text}（${s.done ? '已完成' : '待办'}`).join('；')}`;
      const rec = db.toggleReminderStep(rem.id, steps[target].seq, args?.done === undefined ? undefined : args.done === 1);
      if (!rec) return '勾选失败，请稍后再试。';
      const p = db.stepsProgress(rec.steps);
      return p.total === 0
        ? '已更新。'
        : `已更新：${rec.steps[target].text} → ${rec.steps[target].done ? '完成' : '待办'}。进度 ${p.done}/${p.total}（${p.pct}%）${rec.done === 1 ? '，整条待办已自动完成 🎉' : ''}`;
    },
  },
  {
    name: 'get_schedule',
    description: '查看用户尚未完成的提醒/待办清单。',
    parameters: {
      type: 'object',
      properties: { range: { type: 'string', description: '时间范围描述，可空' } },
      required: [],
    },
    run: (_args, ctx) => {
      const rows = db.listReminders(ctx.owner, false);
      if (!rows.length) return '（暂无待办）';
      return rows
        .map((r, i) => {
          const time = r.due_at ? `（${r.due_at}）` : '';
          const p = db.stepsProgress(r.steps);
          const prog = p.total > 0 ? ` · 进度 ${p.done}/${p.total}` : '';
          return `${i + 1}. ${r.body}${time}${prog}`;
        })
        .join('\n');
    },
  },
  {
    name: 'ask_user',
    description:
      '涉及不可逆或高风险动作（发消息给他人、花钱、删除）前，先向用户确认。返回需要确认的问题与选项。调用后即停止本轮，等待用户确认。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '向用户确认的问题' },
        options: { type: 'string', description: '可选选项，逗号分隔，可空' },
      },
      required: ['question'],
    },
    // 正常不会走到 run：bailian 在拿到 ask_user 调用时会先拦截并终止本轮等用户确认。
    // 这里保留一份实现，保证「工具表里没有空壳」——万一走到了也不会静默失败。
    run: (args, ctx) => {
      const pq = askUser(args, ctx);
      return `（已提交给用户确认）${pq.question}`;
    },
  },
  {
    name: 'web_lookup',
    description:
      '实时联网检索最新资讯（新闻、天气、股价、百科、政策、攻略等）。当用户问的实体/事实可能随时间变化、或需要外部一手信息时调用；不要凭记忆编造实时信息。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，尽量具体，如「2026 北京 医保 新政」「今日 上海 天气」' },
        limit: { type: 'integer', description: '返回条数，默认 3' },
      },
      required: ['query'],
    },
    enabled: () => isWebSearchConfigured(),
    timeoutMs: 30000,
    retries: 2,
    run: async (args) => {
      const q = String(args?.query || '');
      const lim = Number(args?.limit ?? 3);
      let r = await webSearch(q, { limit: lim });
      // dashscope 偶发慢/空：自愈重试一次，降低「查不到」的误判
      if (r.error && process.env.WEB_SEARCH_PROVIDER === 'dashscope') {
        r = await webSearch(q, { limit: lim });
      }
      if (r.error) return `联网检索暂时没接通（${r.error}）。我先记着你的需求，稍后再帮你查～`;
      if (!r.results.length) return `没能联网检索到相关结果，换个关键词我再帮你查？`;
      return r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n');
    },
  },
  {
    name: 'open_artifact',
    description:
      '打开（读取）一个已存在的产物，把它的内容展示给用户。**只读取，绝不新建**。当用户说「打开/看一下/展示《某某》产物」时用这个工具；按标题模糊匹配，也接受产物 id。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '产物标题（支持模糊匹配，如「国庆最后两天」）' },
        id: { type: 'string', description: '产物 id（可选，有 id 时优先）' },
      },
      required: [],
    },
    run: (args, ctx) => {
      const id = args?.id ? String(args.id) : '';
      const title = args?.title ? String(args.title) : '';
      let art = id ? db.getArtifact(id) : null;
      if (!art && title) {
        const all = db.getArtifacts(ctx.owner, 50);
        const t = title.replace(/[《》"'「」\s]/g, '');
        art =
          all.find((a) => String(a.title).replace(/[《》"'「」\s]/g, '').includes(t)) ||
          all.find((a) => String(a.title).replace(/[《》"'「」\s]/g, '') === t) ||
          null;
      }
      if (!art) {
        const names = db.getArtifacts(ctx.owner, 10).map((a) => a.title);
        return `没有找到该产物${title ? `（${title}）` : ''}。当前可用的产物有：${
          names.length ? names.join(' / ') : '（暂无，需要先创建）'
        }`;
      }
      return JSON.stringify({ ok: true, id: art.id, title: art.title, type: art.type, content: art.content });
    },
  },
  {
    name: 'create_artifact',
    description:
      '把交付物固化为结构化「产物」（行程卡 / 报告 / 清单），供用户在「产物画布」查看、编辑与导出。完成规划/研究/总结类任务、且产出值得留存时调用。**若同名产物已存在会自动覆盖更新，不会重复新建**，所以可以放心调用。content 传 JSON 字符串（如行程的 Day 列表）或 Markdown 文本。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '产物类型', enum: ['itinerary', 'report', 'checklist', 'note'] },
        title: { type: 'string', description: '产物标题，如「杭州周末周边游」' },
        content: { type: 'string', description: '产物内容：JSON 字符串或 Markdown 文本' },
      },
      required: ['type', 'title', 'content'],
    },
    run: (args, ctx) => {
      const type = String(args?.type || 'note') as any;
      const title = String(args?.title || '未命名产物');
      const content = String(args?.content || '{}');
      // 幂等：同名产物已存在则覆盖更新，避免反复「重新生成」刷出一堆重复卡片
      const existing = db.getArtifacts(ctx.owner, 50).find((a) => a.title === title);
      if (existing) {
        db.updateArtifact(existing.id, { title, content, type });
        return JSON.stringify({ ok: true, id: existing.id, title, type, updated: true });
      }
      const art = db.createArtifact({ owner: ctx.owner, session_id: ctx.sessionId, type, title, content });
      return JSON.stringify({ ok: true, id: art.id, title: art.title, type: art.type });
    },
  },
  {
    name: 'update_artifact',
    description: '修改已存在的产物（如复核后发现错误需要修正）。id 为 create_artifact 返回的产物 id。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要更新的产物 id' },
        title: { type: 'string', description: '新标题，可空' },
        content: { type: 'string', description: '新内容（JSON 或 Markdown），可空' },
      },
      required: ['id'],
    },
    run: (args) => {
      const id = String(args?.id || '');
      const art = db.getArtifact(id);
      if (!art) return `未找到要更新的产物（id=${id}）`;
      const ok = db.updateArtifact(id, {
        title: args?.title !== undefined ? String(args.title) : undefined,
        content: args?.content !== undefined ? String(args.content) : undefined,
      });
      return JSON.stringify({ ok, id, title: args?.title || art.title, type: art.type });
    },
  },
  {
    name: 'play_music',
    description:
      '播放用户本地音乐库里的歌。当用户想听歌、想放点音乐、点名歌手或歌名时用；也可按心情/场景挑（如「来点安静的」「放首提神的」）。只选曲不搬运：音频始终留在用户自己的磁盘上。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名关键词，如「晴天」「Summer」；不填表示随便挑' },
        artist: { type: 'string', description: '歌手名，如「周杰伦」「久石让」；不填表示不限歌手' },
        limit: { type: 'integer', description: '放进播放列表的曲目数，默认 5，最大 20' },
        reason: { type: 'string', description: '一句话说明你为什么选这些（会显示在播放器上），如「这几首安静，适合现在」' },
      },
      required: [],
    },
    enabled: () => db.countTracks() > 0,
    timeoutMs: 8000,
    retries: 1,
    run: (args) => {
      const q = String(args?.query || '').trim();
      const artist = String(args?.artist || '').trim();
      const limit = Math.max(1, Math.min(20, Number(args?.limit ?? 5) || 5));
      const kw = [q, artist].filter(Boolean).join(' ');
      const picked = db.listTracks(kw || undefined, limit);
      if (!picked.length) {
        return kw
          ? `音乐库里没找到和「${kw}」相关的曲子。可以让用户在「设置 · 本地音乐」里确认目录正确并点一次「扫描目录」。`
          : '音乐库是空的（或还没扫描）。请让用户在「设置 · 本地音乐」里配置音乐目录并点「扫描目录」。';
      }
      setMusicAction({ ids: picked.map((t) => t.id), action: 'play', reason: String(args?.reason || '').trim() || undefined });
      return `已开始播放（${picked.length} 首）：\n${picked.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`).join('\n')}`;
    },
  },
  {
    name: 'control_music',
    description:
      '控制正在播放的音乐：暂停 / 继续 / 下一首 / 上一首 / 调音量。当用户说「暂停」「小声点」「下一首」「继续放」时用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'next', 'prev', 'volume'], description: 'pause 暂停 / resume 继续 / next 下一首 / prev 上一首 / volume 调音量' },
        value: { type: 'number', description: '音量，0~1 的小数，仅 action=volume 时需要' },
      },
      required: ['action'],
    },
    enabled: () => db.countTracks() > 0,
    timeoutMs: 5000,
    retries: 1,
    run: (args) => {
      const action = String(args?.action || '');
      const value = Number(args?.value);
      if (!['pause', 'resume', 'next', 'prev', 'volume'].includes(action)) return '不支持的控制动作。';
      setMusicAction({
        action: action as 'pause' | 'resume' | 'next' | 'prev' | 'volume',
        value: action === 'volume' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined,
      });
      return ({ pause: '已暂停', resume: '继续播放', next: '切到下一首', prev: '回到上一首', volume: '音量已调整' } as Record<string, string>)[action];
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const ALL_TOOL_NAMES = TOOLS.map((t) => t.name);

/** 单工具超时：超时返回清晰错误文本，不让一个外部调用拖死整轮 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

/** 错误容忍：单步失败重试，之后才把错误交给模型让它自行改道（对齐参考架构「最多重试 3 次」） */
async function withRetry<T>(label: string, fn: () => Promise<T>, max: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max + 1; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      console.warn(`[tool:${label}] 第 ${attempt}/${max + 1} 次失败：${e?.message || e}`);
    }
  }
  throw lastErr;
}

/**
 * 本次请求实际可用的工具（schema 视图）。
 * 提示词里的「可用能力清单」必须由此派生，不允许另取一份。
 */
export function activeToolDefs(owner?: string): Array<Pick<Tool, 'name' | 'description' | 'parameters'>> {
  const ctx: ToolContext = { owner: owner || 'guest', sessionId: '', intent: 'other' as IntentCode };
  return TOOLS.filter((t) => !t.enabled || t.enabled(ctx));
}

/**
 * 执行工具。**唯一**执行入口：查注册表调用，不再有第二份 switch 实现。
 * 统一套上超时 + 重试，且永不抛错——错误以文本返回给模型，让它自己改道。
 */
export async function execTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const tool = BY_NAME.get(name);
  if (!tool) return `未知工具：${name}`;
  try {
    // 超时必须包住「原始 promise」，不能等 run() 已经 resolve 了再套——那样等于没超时
    const result = await withRetry(
      name,
      () => withTimeout(Promise.resolve(tool.run(args, ctx)), tool.timeoutMs ?? 15000, name),
      tool.retries ?? 2
    );
    return result;
  } catch (e: any) {
    return `工具执行出错：${e?.message || e}`;
  }
}

/**
 * ask_user 的人在处理：创建待确认项。
 * 放在注册表里是为了让「工具」与「它的副作用」只有一处实现（bailian 只负责拦截与终止本轮）。
 */
export function askUser(args: Record<string, any>, ctx: ToolContext) {
  const opts = parseOptions(args?.options);
  const actionJson = JSON.stringify({
    kind: 'relay',
    text: String(args?.message || args?.question || ''),
    channel: args?.channel || 'message',
    question: args?.question,
    options: args?.options,
  });
  return db.addPendingQuestion(
    ctx.sessionId,
    ctx.owner,
    String(args?.question || '需要你的确认'),
    opts,
    actionJson
  );
}

function parseOptions(v: unknown): string[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
