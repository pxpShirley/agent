/**
 * 初始化演示对话数据：让管理后台开箱即有内容。
 * 定位：AI 生活管家「星澜」——演示多意图对话，不再含 FAQ 知识库 / 工单 / 评分。
 */
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import type { IntentCode } from './db.js';

interface DemoTurn {
  user: string;
  assistant: string;
}

interface DemoConversation {
  customer: string;
  intent: IntentCode;
  daysAgo: number;
  turns: DemoTurn[];
}

const DEMO: DemoConversation[] = [
  {
    customer: '林晚',
    intent: 'life',
    daysAgo: 0,
    turns: [
      {
        user: '最近总是失眠，有什么办法能快点睡着吗',
        assistant:
          '试试这几招：固定起床时间；睡前一小时远离手机蓝光；用「4-7-8 呼吸法」吸气 4 秒、憋 7 秒、慢呼 8 秒循环几次；卧室调暗降温。躺 20 分钟还睡不着就起来做点无聊的事，别硬躺。',
      },
      {
        user: '那白天要喝多少水比较好',
        assistant: '一般每天 1500–1700 毫升、少量多次主动喝，看尿液清亮偏淡就说明够。运动出汗要额外多喝。',
      },
    ],
  },
  {
    customer: '周野',
    intent: 'schedule',
    daysAgo: 0,
    turns: [
      {
        user: '我总是拖延，有没有什么好用的办法',
        assistant:
          '拖延多半是任务太大怕做不好。试试两分钟法则（能两分钟做完立刻做）、把大任务拆成下一步动作、番茄钟专注 25 分钟。先完成再优化，允许不完美。',
      },
    ],
  },
  {
    customer: '苏晴',
    intent: 'emotion',
    daysAgo: 1,
    turns: [
      {
        user: '最近压力好大，感觉快崩了',
        assistant:
          '先抱抱你。先做三件小事把水位降下来：深呼吸 1 分钟、起身走两步、把最担心的写下来。然后挑一件最小的去动，动起来焦虑会松一点。今晚早点睡，你已经做得很好了。',
      },
      { user: '谢谢你，说完好受多了', assistant: '能陪你说说话我也很开心。任何时候想聊了，我都在。记得对自己温柔一点～' },
    ],
  },
  {
    customer: '陈乐',
    intent: 'travel',
    daysAgo: 2,
    turns: [
      {
        user: '周末想在城市周边放松一下，有什么推荐吗',
        assistant:
          '试试这几类：公园露营野餐、看场展览、来场 Citywalk 逛老街、近郊徒步骑行。关键是离开屏幕、动起来、晒到太阳。需要我帮你列个清单吗？',
      },
    ],
  },
  {
    customer: '何川',
    intent: 'knowledge',
    daysAgo: 3,
    turns: [
      {
        user: '为什么天空是蓝色的呀',
        assistant:
          '这是「瑞利散射」：空气分子把波长最短的蓝紫光散射得最厉害，铺满天空，所以我们看到的天偏蓝（人眼对紫不敏感）。日落偏红则因光线穿过更厚大气，蓝紫被散射光了，剩红橙。',
      },
      {
        user: '那量子到底是什么',
        assistant:
          '量子是物理量的最小、不可再分单位，微观很多量是离散跳变的。由此发展出量子力学，能解释原子、激光、半导体；「量子纠缠」指两粒子状态诡异地关联。它本质是套很成功的物理理论。',
      },
    ],
  },
  {
    customer: '罗敏',
    intent: 'life',
    daysAgo: 4,
    turns: [
      {
        user: '厨房油污好难清理，有什么省事的办法',
        assistant:
          '万能组合：小苏打 + 白醋。油烟机先喷小苏打水敷 10 分钟，再喷白醋起泡擦净；灶台热毛巾敷软再擦。平时炒完菜趁热顺手擦一遍，比攒一周好清理十倍。',
      },
    ],
  },
  {
    customer: '高源',
    intent: 'schedule',
    daysAgo: 5,
    turns: [
      {
        user: '怎么制定一份能真正执行的周计划',
        assistant: '三原则：每周只列 3 件必须完成的要事；给任务标具体时间和地点；留出 30% 缓冲。建议周日晚上花 10 分钟规划，每天晨间看一眼。',
      },
    ],
  },
  {
    customer: '叶桐',
    intent: 'travel',
    daysAgo: 6,
    turns: [
      {
        user: '明天出门要带伞吗，怎么看天气穿衣',
        assistant:
          '看降水概率和实时雷达，超 40% 带把折叠伞更稳。穿衣用「洋葱法」内层透气、中层保暖、外层防风，热了能脱。早晚温差大备件外套。我也可以按你的城市查实时天气。',
      },
    ],
  },
  {
    customer: '唐悦',
    intent: 'life',
    daysAgo: 7,
    turns: [
      {
        user: '想科学减肥，有什么建议',
        assistant: '本质是热量缺口：三餐规律七分饱、优先蛋白和蔬菜；每周 3–4 次有氧+力量；保证睡眠；记录饮食更清楚。别节食，每周减 0.5 公斤左右最健康。',
      },
      {
        user: '那平时怎么更省得下钱',
        assistant: '四步：先记账、设月度预算、下单前等 24 小时延迟满足、大额自动转入储蓄。比价、用返利、取消不用的订阅，积少成多。',
      },
    ],
  },
  {
    customer: '范星',
    intent: 'emotion',
    daysAgo: 9,
    turns: [
      {
        user: '总是拖延又忍不住自责，正常吗',
        assistant:
          '太正常了，几乎人人都这样。自责会耗掉行动能量，换成自我同情：承认今天状态不好，做一件最小的事。完成比完美重要，允许慢慢来，已经很勇敢了。',
      },
    ],
  },
  {
    customer: '顾澜',
    intent: 'knowledge',
    daysAgo: 11,
    turns: [
      {
        user: '一斤等于多少克来着',
        assistant: '1 斤 = 500 克；1 公斤 = 1000 克 = 2 斤；1 两 = 50 克。买菜记「半斤 250 克、一斤 500 克」就够用。',
      },
      {
        user: '那怎么提高记忆力',
        assistant: '用间隔重复（1 天、3 天、1 周复习）、联想+图像、睡够觉固化记忆、费曼技巧讲给别人听。少 multitask，专注时记得住。',
      },
    ],
  },
  {
    customer: '邵宁',
    intent: 'other',
    daysAgo: 12,
    turns: [
      {
        user: '你能帮我做点什么呀',
        assistant:
          '我是星澜，你的 AI 生活管家～可以陪你聊天、帮你记提醒和待办、查实时资讯、陪你梳理计划，也会慢慢记住你的偏好。想试试的话，让我帮你记个明天的提醒？',
      },
    ],
  },
];

export function seedDemoConversations(force = false): number {
  if (!force && db.countSessions() > 0) return 0;

  let created = 0;
  DEMO.forEach((conv, idx) => {
    const base = Date.now() - conv.daysAgo * 86400000 - idx * 1200000;
    const sessionId = uuidv4();
    const createdAt = new Date(base).toISOString();

    db.createSession({
      id: sessionId,
      title: conv.turns[0].user.slice(0, 24),
      model: 'claude-sonnet-4',
      customer_name: conv.customer,
      channel: idx % 3 === 0 ? 'app' : 'web',
      status: 'closed',
      intent: conv.intent,
      created_at: createdAt,
      updated_at: new Date(base + conv.turns.length * 120000).toISOString(),
    });

    conv.turns.forEach((turn, i) => {
      db.createMessage({
        id: uuidv4(),
        session_id: sessionId,
        role: 'user',
        content: turn.user,
        intent: conv.intent,
        created_at: new Date(base + i * 120000).toISOString(),
      });
      db.createMessage({
        id: uuidv4(),
        session_id: sessionId,
        role: 'assistant',
        content: turn.assistant,
        model: 'claude-sonnet-4',
        intent: conv.intent,
        created_at: new Date(base + i * 120000 + 45000).toISOString(),
      });
    });
    created++;
  });

  console.log(`[Seed] 演示对话已初始化：${created} 条`);
  return created;
}

export function seedAll(force = false) {
  const conversations = seedDemoConversations(force);
  return { conversations };
}
