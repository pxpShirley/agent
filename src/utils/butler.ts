// 星澜 · 管家大脑（轻量、纯前端、确定性）
// 目标：让管家"先开口、主动呈现"，而非守着一张 FAQ 预设清单。
// 内容由"时间/日期 + 实时上下文（记忆/提醒/情绪）"启发生成，全部为"管家主动留意/提议"，点击即驱动对话。
// 由上下文（记忆/提醒/情绪）生成的卡片会标 insight:true（「洞察」），优先呈现、区别于通用时间提议。

import type { AgentContext } from '../types';

export interface ProactiveCard {
  id: string;
  tone: 'tip' | 'offer' | 'nudge';
  title: string;
  body: string;
  prompt?: string;
  insight?: boolean; // 由实时上下文个性化生成（洞察），非通用时间提议
  tag?: string; // 卡片角标，如「洞察」
}

// 每日简报的一行：由实时上下文（目标/提醒/记忆）+ 时间启发派生，2×2 内联呈现
// human:true 表示「需要你」（唯一允许的暖金使用面，人在做 / 人需确认）
export interface BriefRow {
  key: string;
  kind: 'goal' | 'need' | 'memory' | 'tip';
  label: string; // 今日目标 / 临近提醒 · 需要你 / 记忆关怀 / 今日建议
  title: string;
  human?: boolean;
  action?: string; // 点击即 dispatch 的开口语
}

export interface Capability {
  id: string;
  title: string;
  desc: string;
  icon: string; // 对应 CapIcon 的 key
  prompt: string;
  accent: string;
  category: CapCategory; // 用于能力视图分块
}

export type CapCategory = 'plan' | 'life' | 'grow' | 'create';

// 能力视图按此顺序分块；key 与 Capability.category 对应
export const CAPABILITY_GROUPS: { key: CapCategory; label: string; hint: string }[] = [
  { key: 'plan', label: '出行与规划', hint: '把时间和路线交给我' },
  { key: 'life', label: '生活与健康', hint: '松弛感与好习惯' },
  { key: 'grow', label: '成长与陪伴', hint: '学点东西，或聊聊天' },
  { key: 'create', label: '实用与创作', hint: '省钱、写作这类小事' },
];

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function getGreeting(d: Date = new Date()): { hello: string; sub: string } {
  const h = d.getHours();
  let hello = '你好';
  if (h < 5) hello = '夜深了';
  else if (h < 11) hello = '早上好';
  else if (h < 13) hello = '中午好';
  else if (h < 18) hello = '下午好';
  else hello = '晚上好';
  const sub = `${WEEK[d.getDay()]} · ${d.getMonth() + 1}月${d.getDate()}日`;
  return { hello, sub };
}

// 由"时间 + 日期 + 实时上下文"启发，生成主动卡片（管家先开口）。
// 纯时间/日期触发的是通用提议；结合记忆/提醒/情绪生成的会标 insight:true（「洞察」），优先呈现。
export function getProactiveCards(d: Date = new Date(), ctx?: AgentContext | null): ProactiveCard[] {
  const cards: ProactiveCard[] = [];
  const h = d.getHours();
  const day = d.getDay(); // 0 周日 .. 6 周六
  const now = d.getTime();
  const DAY = 86_400_000;

  // —— 1) 实时上下文驱动的个性化洞察（优先） ——
  if (ctx) {
    // 1a. 逾期 / 临近的提醒
    const reminders = ctx.reminders || [];
    const open = reminders.filter((r) => r.done !== 1);
    for (const r of open) {
      if (r.due_ts === null) continue; // due_at 是自由文本原文，new Date() 会得到 NaN
      const due = r.due_ts;
      const diff = due - now;
      if (diff < 0) {
        cards.push({
          id: `ins-overdue-${r.id}`,
          tone: 'nudge',
          title: '有一件事已经过了时间',
          body: `「${trim(r.body, 18)}」早该做了，要不要现在就处理，或挪到别的时段？`,
          prompt: `帮我处理这件事：「${r.body}」，要么现在做，要么重新安排时间`,
          insight: true,
          tag: '洞察',
        });
      } else if (diff <= DAY) {
        cards.push({
          id: `ins-due-${r.id}`,
          tone: 'nudge',
          title: '有件事就在这 24 小时内',
          body: `「${trim(r.body, 18)}」马上要到点了，趁现在顺手定好时间或准备一下？`,
          prompt: `提醒我「${r.body}」马上就到点了，帮我安排好`,
          insight: true,
          tag: '洞察',
        });
      }
    }

    // 1b. 未完成提醒偏多 → 帮理计划
    if (open.length >= 4) {
      cards.push({
        id: 'ins-load',
        tone: 'nudge',
        title: `你还有 ${open.length} 件待办挂着`,
        body: '待办堆得有点多了。要我帮你在今天和本周之间分个轻重，先啃最要紧的？',
        prompt: '我待办有点多，帮我把这些待办按优先级排进今天和本周',
        insight: true,
        tag: '洞察',
      });
    }

    // 1c. 情绪关怀（最近情绪偏低，或持续走低）
    const moods = ctx.moods || [];
    if (moods.length > 0) {
      const sorted = [...moods].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latest = sorted[0];
      const lv = Number(latest.level);
      if (!Number.isNaN(lv) && lv <= 2) {
        cards.push({
          id: 'ins-mood',
          tone: 'offer',
          title: '看你最近状态有点沉',
          body: latest.note
            ? `你记过：「${trim(latest.note, 16)}」。想聊聊，还是我陪你找点能回点血的小事？`
            : '最近状态好像不太轻盈。想找人聊聊，还是我陪你做点小确幸的事？',
          prompt: '最近有点累，想找你聊聊，或者帮我找点能放松的小事',
          insight: true,
          tag: '洞察',
        });
      } else if (moods.length >= 2 && lv < Number(sorted[1].level)) {
        cards.push({
          id: 'ins-mood-down',
          tone: 'offer',
          title: '你的心情好像在往下走',
          body: '连着两次记录，情绪都比上次低一点。别硬撑，要不要我陪你理理，或推两件事缓缓？',
          prompt: '我最近情绪在走低，想跟你聊聊，帮我理理',
          insight: true,
          tag: '洞察',
        });
      }
    }

    // 1d. 记忆久未更新 → 唤醒
    const memories = ctx.memories || [];
    if (memories.length > 0) {
      const stale = memories
        .map((m) => ({ m, t: new Date(m.updated_at).getTime() }))
        .filter((x) => !Number.isNaN(x.t) && now - x.t > 14 * DAY)
        .sort((a, b) => b.t - a.t)[0];
      if (stale) {
        cards.push({
          id: 'ins-stale',
          tone: 'tip',
          title: '有段记忆好久没碰了',
          body: `「${trim(stale.m.key, 16)}」你记了挺久。要不要更新一下，或确认它现在还重要？`,
          prompt: `帮我看看记的「${stale.m.key}」现在还作数吗，要更新的话顺手更新`,
          insight: true,
          tag: '洞察',
        });
      }
    }

    // 1e. 周五 + 有记忆/提醒 → 上下文版周复盘
    if (day === 5 && (memories.length > 0 || open.length > 0)) {
      cards.push({
        id: 'ins-weekly',
        tone: 'nudge',
        title: '这周你攒了不少事',
        body: `记了 ${memories.length} 条记忆、挂着 ${open.length} 件待办。趁还热乎，来一次周复盘？`,
        prompt: '帮我做一次本周复盘，结合我记的记忆和待办，标出下周重点',
        insight: true,
        tag: '洞察',
      });
    }
  }

  // —— 2) 纯时间/日期的通用提议（非洞察） ——
  if (h < 5) {
    cards.push({
      id: 'night',
      tone: 'tip',
      title: '夜深了，先歇会儿',
      body: '这个点还在忙？我可以帮你把明天的待办先理一理，免得醒来一头乱。',
      prompt: '帮我规划一下明天的待办清单，按优先级排好',
    });
  } else if (h >= 17) {
    cards.push({
      id: 'evening',
      tone: 'offer',
      title: '晚上好，今天有想聊或想记下的吗',
      body: '一天结束了。要我帮你做个当日小结，或者推荐点放松的事？',
      prompt: '帮我做个今天的小结，再推荐两件事让我放松一下',
    });
  }

  if (day === 1 && h < 12) {
    cards.push({
      id: 'mon',
      tone: 'nudge',
      title: '新的一周，要我帮你理计划吗',
      body: '周一上午最适合定调。把本周目标告诉我，我帮你拆成可执行的步子。',
      prompt: '帮我规划这一周的计划，我有工作和生活两摊事',
    });
  }
  // 周五：已有上下文版周复盘时，不再重复通用版本
  const hasWeeklyInsight = cards.some((c) => c.id === 'ins-weekly');
  if (day === 5 && !hasWeeklyInsight) {
    cards.push({
      id: 'fri',
      tone: 'nudge',
      title: '周五了，这周的目标完成得如何',
      body: '趁记忆还热，要我帮你做个周复盘，顺手标出下周该接住的坑？',
      prompt: '帮我做一次本周复盘，并列出下周要重点跟进的事',
    });
  }
  if (day === 6 || day === 0) {
    cards.push({
      id: 'weekend',
      tone: 'offer',
      title: '周末到了，想好去哪了吗',
      body: '不用你做攻略。告诉我城市和大体偏好，我直接给你排好路线和注意点。',
      prompt: '帮我规划一次本周末的周边游，要有路线、吃饭和注意事项',
    });
  }

  // 通用健康微提醒（不依赖外部数据，纯善意提示）
  cards.push({
    id: 'health',
    tone: 'tip',
    title: '久坐记得起来走两步',
    body: '要不要我设个提醒，每小时帮你站起来活动一下？',
    prompt: '提醒我每工作一小时就起来活动五分钟',
  });

  // 洞察优先，再排时间提议；取前 4 张（XinglanShell 也会再 slice(0,4)）
  return cards.slice(0, 4);
}

function trim(s: string, n: number): string {
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
}

// 每日简报：把"主动开口面"收束成 2×2 结构（今日目标 / 临近提醒 / 记忆关怀 / 今日建议）
// 能力已不再有独立页面，发现入口改为「主页内联建议 + ⌘K」，故此处不列能力。
export function getDailyBrief(d: Date = new Date(), ctx?: AgentContext | null): BriefRow[] {
  const rows: BriefRow[] = [];
  const h = d.getHours();
  const now = d.getTime();
  const DAY = 86_400_000;

  const reminders = ctx?.reminders || [];
  const memories = ctx?.memories || [];
  const open = reminders.filter((r) => r.done !== 1);

  // 今日目标：取一个进行中目标；无则提议设定今日目标
  if (open.length > 0) {
    const g = open[0];
    rows.push({
      key: `brief-goal-${g.id}`,
      kind: 'goal',
      label: '今日目标',
      title: g.body,
      action: `陪我推进这件事：${g.body}`,
    });
  } else {
    rows.push({
      key: 'brief-goal-empty',
      kind: 'goal',
      label: '今日目标',
      title: '今天想推进哪件要紧事？',
      action: '帮我把今天最想推进的一件事定下来，并排好步骤',
    });
  }

  // 临近提醒（需要你 · 暖金）：优先逾期，其次 24h 内
  // due_ts 是服务端归一化的 epoch ms（判定唯一依据）；due_at 只是展示原文
  const parseDue = (r: { due_ts?: number | null }) => (typeof r.due_ts === 'number' ? r.due_ts : NaN);
  const overdue = open.find((r) => Number.isNaN(parseDue(r)) === false && parseDue(r) < now);
  const due24 = open.find((r) => Number.isNaN(parseDue(r)) === false && parseDue(r) - now <= DAY && parseDue(r) >= now);
  const need = overdue || due24;
  if (need) {
    const due = parseDue(need);
    const when = Number.isNaN(due) ? '' : due < now ? '已逾期' : '24 小时内';
    rows.push({
      key: `brief-need-${need.id}`,
      kind: 'need',
      label: '临近提醒 · 需要你',
      title: when ? `${need.body} · ${when}` : need.body,
      human: true,
      action: `提醒我关于「${need.body}」${when ? `（${when}）` : ''}`,
    });
  }

  // 记忆关怀：优先挑「偏好/计划」类记忆，作"被记住"的温暖提示
  if (memories.length > 0) {
    const plan = memories.find((m) => m.kind === 'plan' || /目标|计划|这周|本周|想做|推进/.test(`${m.key}${m.value}`));
    const pref = memories.find((m) => m.kind === 'preference' || /偏好|喜欢|习惯|讨厌|忌|作息|沟通/.test(`${m.key}${m.value}`));
    const m = plan || pref || memories[0];
    rows.push({
      key: `brief-memory-${m.id}`,
      kind: 'memory',
      label: '记忆关怀',
      title: m.value,
      action: `回忆一下我记的关于「${m.key || m.value}」的事`,
    });
  } else {
    rows.push({
      key: 'brief-memory-empty',
      kind: 'memory',
      label: '记忆关怀',
      title: '把今天在意的事告诉我',
      action: '我想记一点今天在意的事',
    });
  }

  // 今日建议（时间启发，永远在末位）
  let tipTitle = '今晚要不要试试放空 10 分钟？';
  let tipAction = '陪我做 10 分钟冥想引导';
  if (h < 11) {
    tipTitle = '上午先定个调，今天想推进哪件要紧事？';
    tipAction = '帮我把今天最要紧的一件事定下来并排好步骤';
  } else if (h < 17) {
    tipTitle = '午后状态正佳，要不要理一理接下来的安排？';
    tipAction = '帮我理一理今天剩下的安排';
  }
  rows.push({ key: 'brief-tip', kind: 'tip', label: '今日建议', title: tipTitle, action: tipAction });

  // 2×2 网格，最多 4 行；need 不存在时为 3 行，布局依然稳
  return rows.slice(0, 4);
}

// "全能管家"能力网格——取代了"常见问题 FAQ"的预设感
export const CAPABILITIES: Capability[] = [
  {
    id: 'travel',
    title: '规划一次出行',
    desc: '周边游 / 旅行路线 / 穿衣天气',
    icon: 'travel',
    prompt: '帮我规划一次周末周边游，要有路线、吃饭和注意事项',
    accent: '#0d9488',
    category: 'plan',
  },
  {
    id: 'schedule',
    title: '理一理我的日程',
    desc: '周计划 / 待办 / 克服拖延',
    icon: 'schedule',
    prompt: '帮我把最近要做的事理一理，做个可执行的一周计划',
    accent: '#0ea5a4',
    category: 'plan',
  },
  {
    id: 'relax',
    title: '推荐今晚做点啥',
    desc: '放松 / 独处 / 小确幸',
    icon: 'relax',
    prompt: '今晚在家，给我几个放松又有意思的建议',
    accent: '#14b8a6',
    category: 'life',
  },
  {
    id: 'health',
    title: '健康小习惯',
    desc: '睡眠 / 饮食 / 运动',
    icon: 'health',
    prompt: '给我一些今天就能开始做的小健康习惯',
    accent: '#2dd4bf',
    category: 'life',
  },
  {
    id: 'learn',
    title: '陪我学点东西',
    desc: '科普 / 原理 / 新知',
    icon: 'learn',
    prompt: '用通俗的话给我讲讲一个有趣的知识或原理',
    accent: '#0d9488',
    category: 'grow',
  },
  {
    id: 'chat',
    title: '陪我聊聊',
    desc: '倾诉 / 解压 / 情绪',
    icon: 'chat',
    prompt: '最近有点累，想找人聊聊心里的事',
    accent: '#0ea5a4',
    category: 'grow',
  },
  {
    id: 'save',
    title: '帮我省点钱',
    desc: '记账 / 省钱 / 预算',
    icon: 'save',
    prompt: '帮我想想办法，这个月能省下一些钱',
    accent: '#14b8a6',
    category: 'create',
  },
  {
    id: 'write',
    title: '帮我写点什么',
    desc: '祝福 / 文案 / 邮件',
    icon: 'write',
    prompt: '帮我写一段给朋友的暖心生日祝福',
    accent: '#2dd4bf',
    category: 'create',
  },
];
