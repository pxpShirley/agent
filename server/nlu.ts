/**
 * NLU 模块：中文意图识别（无外部依赖，关键词加权）
 */
import type { IntentCode } from './db.js';

export const INTENT_LABELS: Record<IntentCode, string> = {
  life: '生活百科',
  schedule: '日程规划',
  travel: '出行玩乐',
  knowledge: '知识解答',
  emotion: '情感陪伴',
  other: '其他',
};

/** 各意图的关键词库（权重：命中一次得分） */
const INTENT_KEYWORDS: Record<Exclude<IntentCode, 'other'>, Array<[string, number]>> = {
  life: [
    ['健康', 2.5], ['养生', 2], ['减肥', 2.5], ['失眠', 2.5], ['睡眠', 2], ['熬夜', 2],
    ['运动', 2], ['健身', 2], ['饮食', 2], ['食谱', 2.5], ['做饭', 2], ['早餐', 1.5],
    ['皮肤', 2], ['护肤', 2], ['感冒', 2], ['上火', 2], ['养胃', 2], ['水果', 1.5],
    ['收纳', 2.5], ['整理', 2], ['清洁', 2], ['断舍离', 2.5], ['打扫', 2], ['居家', 1.5],
    ['省钱', 2.5], ['理财', 2.5], ['记账', 2], ['攒钱', 2.5], ['预算', 2], ['日常', 1.5],
    ['喝水', 1.5], ['指甲', 1], ['衣服', 1.2], ['去污', 2], ['生活小妙招', 3], ['小技巧', 2],
  ],
  schedule: [
    ['提醒', 3], ['闹钟', 3], ['日程', 3], ['安排', 2.5], ['计划', 2.5], ['待办', 3],
    ['备忘', 2.5], ['规划', 2.5], ['周计划', 3], ['月目标', 2.5], ['目标', 2], ['习惯', 2.5],
    ['打卡', 2.5], ['番茄', 2.5], ['效率', 2], ['拖延', 3], ['截止', 2], ['时间管理', 3],
    ['生日', 2], ['纪念日', 2], ['约会', 2], ['今天做什么', 3], ['明天', 1.5], ['几点', 1.5],
  ],
  travel: [
    ['旅游', 3], ['旅行', 3], ['出行', 2.5], ['攻略', 3], ['机票', 3], ['火车票', 3],
    ['高铁', 2.5], ['酒店', 2.5], ['民宿', 2.5], ['景点', 2.5], ['路线', 2.5], ['自驾', 2.5],
    ['签证', 2.5], ['天气', 2.5], ['穿衣', 2], ['穿什么', 2.5], ['外卖', 2], ['餐厅', 2],
    ['美食', 2.5], ['好吃', 2], ['电影', 2], ['演出', 2], ['展览', 2], ['周末去哪', 3],
    ['周边游', 2.5], ['度假', 2.5], ['行李', 2],
  ],
  knowledge: [
    ['为什么', 2.5], ['是什么', 2.5], ['怎么', 1.5], ['如何', 1.5], ['原理', 2.5], ['解释', 2],
    ['区别', 2], ['意思', 2], ['概念', 2], ['科学', 2], ['历史', 2], ['天文', 2],
    ['地理', 2], ['冷知识', 3], ['百科', 2.5], ['计算', 2], ['换算', 2.5], ['翻译', 2.5],
    ['单位', 2], ['等于多少', 2.5], ['推荐', 1.5], ['建议', 1.5], ['入门', 2], ['学习', 2],
  ],
  emotion: [
    ['难过', 3], ['焦虑', 3], ['压力', 3], ['孤独', 3], ['委屈', 3], ['烦', 2.5], ['不开心', 3],
    ['抑郁', 3], ['emo', 3], ['失恋', 3], ['想念', 2.5], ['累了', 2.5], ['崩溃', 3], ['没人懂', 3],
    ['倾诉', 3], ['安慰', 3], ['陪伴', 3], ['无聊', 2.5], ['迷茫', 3], ['心烦', 2.5], ['哭', 2.5],
    ['不开心', 3], ['想聊', 2.5], ['听我说', 3],
  ],
};

export interface IntentResult {
  intent: IntentCode;
  confidence: number;
  scores: Record<string, number>;
}

export function classifyIntent(text: string): IntentResult {
  const lower = (text || '').toLowerCase();
  const scores: Record<string, number> = { life: 0, schedule: 0, travel: 0, knowledge: 0, emotion: 0 };

  (Object.keys(INTENT_KEYWORDS) as Array<Exclude<IntentCode, 'other'>>).forEach((intent) => {
    for (const [kw, weight] of INTENT_KEYWORDS[intent]) {
      if (lower.includes(kw)) scores[intent] += weight;
    }
  });

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;

  if (topScore <= 0) {
    return { intent: 'other', confidence: 0.25, scores };
  }

  // 置信度：得分越高、与第二名差距越大越自信
  const margin = (topScore - secondScore) / Math.max(topScore, 1);
  const confidence = Math.min(0.98, 0.45 + Math.min(topScore / 8, 0.35) + margin * 0.2);

  return {
    intent: topIntent as IntentCode,
    confidence: Number(confidence.toFixed(2)),
    scores,
  };
}
