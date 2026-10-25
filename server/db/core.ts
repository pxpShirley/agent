import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CHAT_DB_PATH：测试用，指向临时库，避免回归测试污染真实数据
const dbPath = process.env.CHAT_DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: DatabaseType = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // 并发写（调度器 + 探针/运维）时避免 SQLITE_BUSY
db.pragma('foreign_keys = ON');

// ============================================================
// 表结构
// ============================================================
db.exec(`
  -- 会话（一次客服对话）
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    customer_name TEXT NOT NULL DEFAULT '访客',
    channel TEXT NOT NULL DEFAULT 'web',
    -- bot: 进行中 / closed: 已结束
    status TEXT NOT NULL DEFAULT 'bot',
    intent TEXT NOT NULL DEFAULT 'other',
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 消息
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    model TEXT,
    intent TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
`);

db.exec(`
  -- 用户长期记忆（跨会话画像）
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT 'guest',
    kind TEXT NOT NULL DEFAULT 'fact',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner);

  -- 提醒 / 待办
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT 'guest',
    due_at TEXT,
    body TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner);

  -- 情绪打卡
  CREATE TABLE IF NOT EXISTS moods (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT 'guest',
    level INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_moods_owner ON moods(owner);

  -- Agent 运行遥测
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    prompt TEXT,
    intent TEXT,
    tools_used TEXT,
    outcome TEXT,
    model TEXT,
    -- L0+ ② 主循环 span 埋点（2026-10-08）：没有它们就没法证明「并行执行/记忆预注入真省了轮次」
    iterations INTEGER,        -- 本轮 ReAct 循环实际迭代次数
    tool_calls_count INTEGER,  -- 本轮工具调用总次数
    parallel_rounds INTEGER,   -- 其中走了并发分支的轮次数
    latency_ms INTEGER,        -- 整轮耗时
    source TEXT,               -- 'user' 用户对话 | 'proactive' 调度器主动发起（见 db/ops.ts 注释）
    created_at TEXT NOT NULL
  );

  -- 人在环 override 日志（转人工 / 敏感确认）
  CREATE TABLE IF NOT EXISTS overrides (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    reason TEXT,
    action TEXT,
    created_at TEXT NOT NULL
  );
`);

// 回放级 trace（P0·2026-10-25）：把一次对话轮拆成有序 span 落库，
// 让「主动时机是否真触发 / 模型每轮到底想了什么 / 哪些工具被调」可只读回放，不回灌模型。
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_spans (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,          -- 关联 agent_runs.id
    seq INTEGER NOT NULL,          -- 同一次 run 内的发生顺序（1,2,3…）
    phase TEXT NOT NULL,           -- think | tool_call | tool_result | ask_user | error | intent
    tool TEXT,                     -- tool_call / tool_result 阶段的工具名
    args_json TEXT,                -- tool_call 的入参摘要（JSON 文本，已截断）
    result_json TEXT,              -- tool_result 的返回摘要（文本，已截断）
    text TEXT,                     -- think / ask_user / error / intent 的可见文本（已截断）
    tokens INTEGER,                -- 预留：该 span 估算 token（当前未使用）
    ms INTEGER,                    -- 预留：该 span 耗时（当前未使用）
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_spans_run ON agent_spans(run_id, seq);
`);

// 人在环：待用户确认的高风险动作（ask_user 闭环）
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT 'guest',
    question TEXT NOT NULL,
    options TEXT,            -- JSON 数组，可空
    status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled
    answer TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_questions(session_id);
`);

// ---- 轻量迁移：为旧库补列 ----
function ensureColumn(table: string, column: string, ddl: string) {
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`[DB] migrate: ${table}.${column} added`);
    }
  } catch {
    /* ignore */
  }
}
ensureColumn('sessions', 'sdk_session_id', 'sdk_session_id TEXT');
ensureColumn('sessions', 'customer_name', "customer_name TEXT NOT NULL DEFAULT '访客'");
ensureColumn('sessions', 'channel', "channel TEXT NOT NULL DEFAULT 'web'");
ensureColumn('sessions', 'status', "status TEXT NOT NULL DEFAULT 'bot'");
ensureColumn('sessions', 'intent', "intent TEXT NOT NULL DEFAULT 'other'");
ensureColumn('sessions', 'resolved', 'resolved INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'intent', 'intent TEXT');
ensureColumn('pending_questions', 'action_json', 'action_json TEXT');
// 记忆可带「过期时间」：时间绑定的事实（如「本周出差上海」）到期后可被清理
ensureColumn('memories', 'expire_at', 'expire_at TEXT');
// due_at 是**人类可读原文**（模型/用户怎么写就怎么存，仅供展示，绝不参与比较）；
// due_ts 是同一时刻的 epoch ms，一切到期/逾期/排序/进度计算只准用它。
ensureColumn('reminders', 'due_ts', 'due_ts INTEGER');
// steps 是待办的子步骤清单（JSON：[{seq,text,done}]），模型/用户产出的展示内容，
// 不参与 SQL 比较，所以存 JSON 即可，不必再拆结构化列。
ensureColumn('reminders', 'steps', "steps TEXT NOT NULL DEFAULT '[]'");
// 周期/习惯提醒（B2）：recur_rule 存结构化的重复规则 JSON（NULL=一次性）；
// series_id 把同一习惯的各期串成一条链，便于「打卡=完成后滚到下一期」。
ensureColumn('reminders', 'recur_rule', 'recur_rule TEXT');
ensureColumn('reminders', 'series_id', 'series_id TEXT');
// agent_runs 的主循环 span 列（旧库补列，新库已在 DDL 里带上，此处自动 no-op）
ensureColumn('agent_runs', 'iterations', 'iterations INTEGER');
ensureColumn('agent_runs', 'tool_calls_count', 'tool_calls_count INTEGER');
ensureColumn('agent_runs', 'parallel_rounds', 'parallel_rounds INTEGER');
ensureColumn('agent_runs', 'latency_ms', 'latency_ms INTEGER');
// 区分「用户说话」与「星澜主动开口」：没有它就无法统计主动服务的真实触发次数
ensureColumn('agent_runs', 'source', 'source TEXT');
// 回填：加列之前的旧 run 没有 source。调度器发起的 run 一律用 `sched-` 前缀
// （见 scheduler.ts），据此区分；其余视为用户对话。
// 不回填的话，历史数据里主动服务的次数会被全部算成「用户说话」，统计直接失真。
try {
  db.exec(`UPDATE agent_runs SET source = 'proactive' WHERE source IS NULL AND session_id LIKE 'sched-%'`);
  db.exec(`UPDATE agent_runs SET source = 'user' WHERE source IS NULL`);
} catch {
  /* 回填失败不影响启动，只是历史数据的来源标注缺失 */
}

// ============================================================
// 类型
// ============================================================
export type SessionStatus = 'bot' | 'closed';
export type IntentCode = 'life' | 'schedule' | 'travel' | 'knowledge' | 'emotion' | 'other';

export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  customer_name: string;
  channel: string;
  status: SessionStatus;
  intent: IntentCode;
  resolved: number;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  intent: string | null;
  created_at: string;
  tool_calls: string | null;
}

export const now = () => new Date().toISOString();

// 主动卡片（scheduler 产出：晨报 / 到期提醒 / 周复盘）
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS proactive_cards (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  ref_id TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_owner ON proactive_cards(owner);
CREATE INDEX IF NOT EXISTS idx_proactive_kind ON proactive_cards(kind);
CREATE INDEX IF NOT EXISTS idx_proactive_ref ON proactive_cards(ref_id);
`);

// 主动卡内联动作（A4）：actions 存结构化动作清单 JSON（NULL=无动作）；读取时由 parseActions 容错解析。
// 必须放在 proactive_cards 表创建之后，否则 ALTER 会因表不存在而静默失败。
ensureColumn('proactive_cards', 'actions', 'actions TEXT');

// 主动卡反馈：用户 seen/dismiss 一张卡 → 记一条信号，用于让主动服务越用越懂你
db.exec(`
CREATE TABLE IF NOT EXISTS proactive_feedback (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  card_id TEXT,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,  -- seen | dismissed
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pf_owner ON proactive_feedback(owner);
`);

// 产物（Artifact）：Agent 交付的结构化、可编辑、可分享对象（行程卡 / 报告 / 清单）
db.exec(`
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT 'guest',
  session_id TEXT,
  type TEXT NOT NULL DEFAULT 'note',   -- itinerary | report | checklist | note
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',  -- JSON 或 Markdown 文本
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner);
`);

// 产物版本历史：每次改动前快照旧版本，支持查看与回滚（P2 活产物）
db.exec(`
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_av_artifact ON artifact_versions(artifact_id);
`);

// 本地音乐索引（M 音乐能力）：只存路径与元数据，音频文件本体永远留在用户磁盘上，不复制不入库
db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,       -- 绝对路径（唯一真相源）
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration REAL,                   -- 秒；未知为 NULL
  mtime INTEGER NOT NULL DEFAULT 0,-- 文件修改时间，用于增量判断
  size INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
`);