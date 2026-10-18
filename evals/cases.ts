/**
 * Evals 用例集 —— 星澜 Agent 的行为回归。
 *
 * 设计原则（写在最前面，因为后人最容易把它改坏）：
 *
 * 1. **不用 LLM 打分**。打分模型本身会漂移，同一句话今天判过明天判不过，
 *    eval 就从"尺子"退化成"另一根会伸缩的橡皮筋"。这里只用可复现的规则：
 *    调没调某个工具 / 文本里有没有某个串 / 有没有踩到禁用话术。
 *
 * 2. **每条用例必须写 `why`**。它记录了这条断言是在防哪一个已经发生过的具体事故。
 *    没有 why 的用例会被后人当成"随手写的测试"删掉——那正是它要防的东西再次发生的开始。
 *
 * 3. **断言要能证伪，不能只要求"说得好听"**。
 *    比如产物那条用 **canary 串**（只有真的读了产物才会出现的词），
 *    而不是"回复里提到了行程"——后者凭记忆编一段也能过。
 *
 * 4. **不要用会随模型心情变化的强断言**（如整句匹配）。
 *    需要"至少命中一个"时用 mustIncludeAny / mustMatchAny / toolCalledAny。
 *
 * 运行：npm run eval
 */
import type * as DbNS from '../server/db.js';

export interface SeedCtx {
  db: typeof DbNS;
  owner: string;
  sessionId: string;
}

export interface Expect {
  /** 最终回复必须全部包含这些串 */
  mustInclude?: string[];
  /** 最终回复必须至少包含其中一个串 */
  mustIncludeAny?: string[];
  /** 最终回复必须至少匹配其中一个正则（比纯串匹配稳，能表达"出现了具体时间"这类结构） */
  mustMatchAny?: RegExp[];
  /** 最终回复不得包含这些串 */
  mustNotInclude?: string[];
  /** 必须调用过的工具（全部） */
  toolCalled?: string[];
  /** 至少调用过其中一个工具 */
  toolCalledAny?: string[];
  /** 绝不能调用的工具 */
  toolNotCalled?: string[];
  /** 幻觉防线：不许出现"刚才其实没做 / 这次是真的"这类自我否定 */
  noSelfDenial?: boolean;
}

export interface EvalCase {
  id: string;
  name: string;
  /** 这条在防哪一个真实事故 —— 必填 */
  why: string;
  intent?: DbNS.IntentCode;
  /** 预置数据：产物 / 曲库 / 记忆。放在这里而不是全局，
   *  因为数据感知裁剪（activeToolDefs）会让"库里没有"时工具根本不暴露。 */
  seed?: (ctx: SeedCtx) => void;
  /** 多轮用户原话，逐条喂给引擎 */
  turns: string[];
  expect: Expect;
}

/** 空泛反问的话术库：把球整个踢回给用户，是提示词第 7 条明令禁止的 */
export const EMPTY_QUESTION = [
  '提醒什么事',
  '提醒什么内容',
  '什么提醒',
  '请告诉我具体',
  '你想提醒什么',
  '需要提醒什么',
  '请问要提醒',
  '你想让我做什么',
  '能具体说说吗',
];

/** 自我否定话术：工具已经返回成功，模型事后改口说没做 —— 比做错更伤信任 */
export const SELF_DENIAL = [
  '其实没',
  '其实没有',
  '刚才没',
  '刚才没有',
  '这次是真的',
  '是我表述',
  '我表述太急',
  '之前那次不算',
];

/**
 * 只有真的读了产物内容才可能说出的串：canary。
 *
 * ⚠️ 第一版用的是「颐和园 · 傍晚昆明湖」——结果模型没调 open_artifact 也"说中了"，
 *    因为「国庆最后两天 + 北京」本来就能猜出 798 / 颐和园。
 *    教训：**canary 必须是模型凭常识编不出来的**，否则它测的是模型的地理知识，不是它有没有读文件。
 *    现在掺一个随机暗号，命中即证明真的读过了。
 */
export const ARTIFACT_CANARY = 'EVAL-CANARY-7F3A';

export const CASES: EvalCase[] = [
  {
    id: 'multiturn-anaphora',
    name: '多轮指代补全：「帮我设个提醒」必须接住上文',
    why:
      '用户先说了「明天上午十点去国贸三期开会」再说「帮我设个提醒」，模型曾把它当成孤立的新问题，' +
      '反问「提醒什么事？什么时候？」——把球整个踢回去。提示词第 6/7 条就是为这个写的，但没有 eval 兜着就会复发。',
    intent: 'schedule',
    turns: ['明天上午十点我要去国贸三期开会', '帮我设个提醒'],
    expect: {
      toolCalled: ['set_reminder'],
      // 内容里必须带上文的信息，证明它不是凭空编了个提醒
      mustIncludeAny: ['国贸', '开会'],
      mustNotInclude: EMPTY_QUESTION,
    },
  },
  {
    id: 'deflect-to-music',
    name: '婉拒场景：说「不想休息想听歌」就该放歌，不是继续劝睡',
    why:
      '提醒卡上用户点「我现在还不想休息，想听歌」，模型曾把它理解成"要改提醒"，继续劝「还是早点休息吧」。' +
      '用户的意思是"我要陪"，不是"我要改"。',
    intent: 'emotion',
    seed: ({ db, owner }) => {
      // 不播种曲库的话 play_music 会被数据感知裁剪掉（enabled: countTracks()>0），
      // 模型根本看不到这个工具 —— 那这条 eval 就成了空转。
      db.upsertTrack({ path: 'E:/eval/quiet-1.mp3', title: '夜的第七章', artist: '久石让', mtime: 1, size: 1 });
      db.upsertTrack({ path: 'E:/eval/quiet-2.mp3', title: '菊次郎的夏天', artist: '久石让', mtime: 1, size: 1 });
      void owner;
    },
    turns: ['我现在还不想休息，想听歌'],
    expect: {
      toolCalled: ['play_music'],
      mustNotInclude: ['早点休息', '该睡了', '还是早点', '建议早点'],
      noSelfDenial: true,
    },
  },
  {
    id: 'no-empty-question',
    name: '空泛反问防线：零上下文也禁止把球踢回去',
    why:
      '最严苛的一档：用户只说「帮我设个提醒」，上文什么都没有。' +
      '禁止的行为是回一句「提醒什么事？」把球踢回去。' +
      '⚠️ 这里**不强求调工具**：提示词第 7 条给的范例本身就是「帮你设个『今晚 22:30 早点睡』的提醒？你说一声我就改」——' +
      '先给具体推断、让用户一句话确认，是合规的（第一版断言要求必须调 set_reminder/ask_user，属于我把自己的偏好写成了标准）。' +
      '真正要守住的是：回复里必须有**具体时间**，且不能是空泛反问。',
    intent: 'schedule',
    turns: ['帮我设个提醒'],
    expect: {
      mustNotInclude: EMPTY_QUESTION,
      mustMatchAny: [/\d{1,2}[:：]\d{2}/, /\d{1,2}\s*点/, /(上午|下午|中午|晚上|早上|今晚|明早|明天)/],
    },
  },
  {
    id: 'artifact-must-open',
    name: '「打开产物」必须是读取，不是复述也不是重建',
    why:
      '用户说「打开一下我之前那个《国庆最后两天安排》」，模型曾凭对话记忆复述内容（编造），或者干脆又 create 了一遍。\n' +
      '⚠️ 这里**断言的是"用户拿到的内容是真的"，不是"内部走了 open_artifact 这条路径"**——\n' +
      '第一版写成 toolCalled: [open_artifact]，结果挂了：引擎里早有服务端兜底 tryFindArtifactContent()\n' +
      '（bailian.ts:291），命中"打开《某产物》"时直接把真实内容拼进用户消息，模型根本不用调工具也编不了。\n' +
      '那是能力层的硬保证，比"求模型记得调工具"可靠得多。所以断言改成 canary：内容必须为真，走哪条路随它。\n' +
      '教训：**eval 要测用户得到了什么，不要测内部走了哪条路**——否则会把一个合法的实现改进判成失败。',
    intent: 'other',
    seed: ({ db, owner, sessionId }) => {
      db.createArtifact({
        owner,
        session_id: sessionId,
        type: 'itinerary',
        title: '国庆最后两天安排',
        content: JSON.stringify({
          days: [
            { date: '10月7日', plan: `798 艺术区 · 下午三点木木美术馆（暗号 ${ARTIFACT_CANARY}）` },
            { date: '10月8日', plan: '颐和园 · 傍晚昆明湖' },
          ],
        }),
      });
    },
    turns: ['打开一下我之前那个《国庆最后两天安排》的产物看看'],
    expect: {
      // 不要求走 open_artifact：服务端兜底已经把真内容塞进去了，强求调工具只会逼它多绕一轮
      toolNotCalled: ['create_artifact', 'update_artifact'],
      // canary：内容必须为真 —— 凭记忆编不出来
      mustInclude: [ARTIFACT_CANARY],
      noSelfDenial: true,
    },
  },
];
