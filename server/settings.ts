/**
 * 自助凭证与运行设置。
 * - 只读接口返回脱敏视图（绝不回传明文密钥）。
 * - 写入接口仅允许白名单字段，原子写回 .env，并实时同步到 process.env，
 *   使配置在本进程内立即生效，无需重启服务。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

/** 可经设置页自助配置的密钥字段（白名单） */
export interface CredentialFieldDef {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
}

export const CREDENTIAL_FIELDS: CredentialFieldDef[] = [
  {
    key: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek API Key（推荐 · OpenAI 兼容）',
    placeholder: '粘贴你的 DeepSeek API Key（sk-...）',
    hint: '配置后星澜接入 DeepSeek 真实大模型（deepseek-chat）。OpenAI 兼容协议，支持工具调用；优先级高于百炼。',
  },
  {
    key: 'BAILIAN_API_KEY',
    label: '百炼 API Key（阿里云 DashScope / 通义千问）',
    placeholder: '粘贴你的百炼 DashScope API Key',
    hint: '配置后星澜将接入阿里云百炼（通义千问）真实大模型，由 Qwen 实时驱动记忆 / 办事 / 晨报 / 联网。优先级低于 DeepSeek，高于 CodeBuddy SDK。',
  },
  {
    key: 'BOCHA_API_KEY',
    label: '博查 AI 搜索 Key（国内源 · 联网检索，推荐）',
    placeholder: '粘贴你的博查（api.bochaai.com）Key',
    hint: '配置后星澜获得真实联网检索能力（web_lookup）。国内直连、延迟最低（实测约 150ms）。不填则回退到 Tavily。',
  },
  {
    key: 'TAVILY_API_KEY',
    label: 'Tavily API Key（联网检索 · 备选）',
    placeholder: '粘贴你的 Tavily Key（tvly-...）',
    hint: '配置后星澜获得真实联网检索能力（web_lookup）。专为大模型设计的搜索 API，免费额度 1000 次/月。',
  },
  {
    key: 'OUTBOUND_WEBHOOK_URL',
    label: '出站 Webhook URL（打通真实动作）',
    placeholder: 'https://hooks.xxx/... 或飞书/企微机器人地址',
    hint: '配置后，人在环确认的高风险动作（发消息等）与新建提醒会真实 POST 到此地址；可用 IFTTT / Zapier 接任意外部服务（飞书/企微/日历/短信）。',
  },
  {
    key: 'SMTP_HOST',
    label: 'SMTP 主机（邮件通道·备选）',
    placeholder: 'smtp.example.com',
    hint: '仅当想用邮件作为兜底出站通道时填写；需配合 SMTP_USER / SMTP_PASS / SMTP_FROM。依赖 nodemailer。',
  },
  {
    key: 'SMTP_USER',
    label: 'SMTP 用户名',
    placeholder: 'user@example.com',
    hint: '邮件通道凭证',
  },
  {
    key: 'SMTP_PASS',
    label: 'SMTP 密码 / 授权码',
    placeholder: 'SMTP 密码或邮箱授权码',
    hint: '邮件通道凭证（私密，不会明文回传）',
  },
  {
    key: 'SMTP_FROM',
    label: '发件人地址',
    placeholder: 'xinglan@example.com',
    hint: '邮件显示发件人',
  },
];

const SDK_ENV_KEYS = CREDENTIAL_FIELDS.map((f) => f.key);

/** 智能引擎是否已就绪（实时读取 process.env） */
export function isSdkConfigured(): boolean {
  return SDK_ENV_KEYS.some((k) => process.env[k] && String(process.env[k]).trim().length > 0);
}

/** 是否处于离线演示模式（实时读取 process.env） */
export function isMockMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.MOCK_AGENT || '');
}

/** 百炼（阿里云 DashScope / 通义千问）是否已配置（实时读取 process.env） */
export function isBailianConfigured(): boolean {
  return Boolean(process.env.BAILIAN_API_KEY && String(process.env.BAILIAN_API_KEY).trim().length > 0);
}

/** 读取百炼 API Key（实时读取 process.env） */
export function getBailianApiKey(): string {
  return process.env.BAILIAN_API_KEY || '';
}

/** 百炼模型名（实时读取 process.env；默认 qwen-plus，可用 BAILIAN_MODEL 覆盖为 qwen-max 等） */
export function getBailianModel(): string {
  return process.env.BAILIAN_MODEL || 'qwen-plus';
}

/** DeepSeek 是否已配置（实时读取 process.env） */
export function isDeepSeekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY && String(process.env.DEEPSEEK_API_KEY).trim().length > 0);
}

/** 读取 DeepSeek API Key（实时读取 process.env） */
export function getDeepSeekApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || '';
}

/** DeepSeek 模型名（默认 deepseek-chat；可用 DEEPSEEK_MODEL 覆盖） */
export function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL || 'deepseek-chat';
}

/** DeepSeek 端点（OpenAI 兼容；可用 DEEPSEEK_BASE_URL 覆盖，便于代理/私有化） */
export function getDeepSeekEndpoint(): string {
  return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
}

/** 运行设置页可选的 DeepSeek 模型清单 */
export const DEEPSEEK_MODELS: Array<{ modelId: string; name: string }> = [
  { modelId: 'deepseek-chat', name: 'deepseek-chat · 通用对话（推荐，工具调用稳定）' },
  { modelId: 'deepseek-reasoner', name: 'deepseek-reasoner · 推理型（较慢，工具调用受限）' },
];

/** OpenAI 兼容引擎（DeepSeek / 百炼）是否任一已配置 */
export function isCompatEngineConfigured(): boolean {
  return isDeepSeekConfigured() || isBailianConfigured();
}

/** 当前生效的对话默认模型（按供应商优先级：DeepSeek > 百炼）。
 *  注意与 getDefaultModel() 区分：后者是 CodeBuddy SDK 的模型字段，语义不同。 */
export function getChatModel(): string {
  return isDeepSeekConfigured() ? getDeepSeekModel() : getBailianModel();
}

/** 运行设置页可选的百炼（通义千问 / DashScope）模型清单；用户也可自由输入其他模型名 */
export const BAILIAN_MODELS: Array<{ modelId: string; name: string }> = [
  { modelId: 'qwen3.7-flash', name: 'qwen3.7-flash · 当前默认（快）' },
  { modelId: 'qwen-plus', name: 'qwen-plus · 均衡' },
  { modelId: 'qwen-max', name: 'qwen-max · 最强能力' },
  { modelId: 'qwen-turbo', name: 'qwen-turbo · 最便宜最快' },
  { modelId: 'qwen-long', name: 'qwen-long · 超长上下文' },
  { modelId: 'qwen3.5-plus', name: 'qwen3.5-plus' },
  { modelId: 'qwen2.5-72b-instruct', name: 'qwen2.5-72b-instruct' },
  { modelId: 'qwq-32b', name: 'qwq-32b · 推理型' },
];

/** 出站 Webhook URL（实时读取 process.env） */
export function getOutboundWebhook(): string {
  return process.env.OUTBOUND_WEBHOOK_URL || '';
}

/** 出站 Webhook 是否已配置（实时读取 process.env） */
export function isOutboundConfigured(): boolean {
  return Boolean(process.env.OUTBOUND_WEBHOOK_URL && process.env.OUTBOUND_WEBHOOK_URL.trim());
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** SMTP 配置（实时读取 process.env；端口默认 465，可用 SMTP_PORT 覆盖） */
export function getSmtpConfig(): SmtpConfig {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  };
}

/** SMTP 是否已配置（实时读取 process.env） */
export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** 默认模型（实时读取 process.env）。
 *  注意：CodeBuddy CLI 仅接受自有模型名（auto / hy3 / glm-5.2 / kimi-k3-1 / deepseek-v4-*），
 *  并不兼容 claude-* 系列，故默认值使用 auto。 */
export function getDefaultModel(): string {
  return process.env.DEFAULT_MODEL || 'auto';
}

function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return v.length ? '••••••' : '';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

function encodeEnv(value: string): string {
  if (/[\s#"'=]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

export interface CredentialView {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  set: boolean;
  preview?: string;
}

/** 本地音乐目录（实时读取 process.env；为空则用系统「音乐」目录） */
export function getMusicDir(): string {
  return (process.env.MUSIC_DIR || '').trim();
}

export interface SettingsView {
  credentials: CredentialView[];
  mockAgent: boolean;
  defaultModel: string;
  /** 百炼（通义千问 / DashScope）当前模型，配置的唯一真相源（BAILIAN_MODEL） */
  bailianModel: string;
  /** DeepSeek 当前模型，配置的唯一真相源（DEEPSEEK_MODEL） */
  deepseekModel: string;
  /** 当前实际生效的对话供应商：deepseek | bailian | none */
  chatProvider: 'deepseek' | 'bailian' | 'none';
  sdkActive: boolean;
  /** 本地音乐目录（空 = 未配置，回退系统音乐目录） */
  musicDir: string;
  notes: string[];
}

export function getSettings(): SettingsView {
  const credentials: CredentialView[] = CREDENTIAL_FIELDS.map((f) => {
    const raw = process.env[f.key];
    const set = Boolean(raw && String(raw).trim().length > 0);
    return { key: f.key, label: f.label, placeholder: f.placeholder, hint: f.hint, set, preview: set ? mask(String(raw)) : undefined };
  });
  const notes: string[] = [];
  if (!isSdkConfigured() && !isMockMode()) {
    notes.push('尚未配置任何智能引擎凭证，也未开启演示模式。配置任一凭证或打开「演示模式」后即可启用管家。');
  } else if (isMockMode() && isSdkConfigured()) {
    notes.push('已检测到凭证且演示模式开启：当前优先使用演示模式（本地规则），关闭演示模式后将切换为真实引擎。');
  }
  if (isDeepSeekConfigured()) {
    notes.push(`对话引擎：DeepSeek（${getDeepSeekModel()}）· OpenAI 兼容协议，工具调用可用。`);
  } else if (isBailianConfigured()) {
    notes.push(`对话引擎：百炼 / 通义千问（${getBailianModel()}）· 未配置 DEEPSEEK_API_KEY，回退到百炼。`);
  }
  return {
    credentials,
    mockAgent: isMockMode(),
    defaultModel: getDefaultModel(),
    bailianModel: getBailianModel(),
    deepseekModel: getDeepSeekModel(),
    chatProvider: isDeepSeekConfigured() ? 'deepseek' : isBailianConfigured() ? 'bailian' : 'none',
    sdkActive: isSdkConfigured(),
    musicDir: getMusicDir(),
    notes,
  };
}

export interface SettingsPatch {
  /** 密钥明文；传空串表示清除该密钥 */
  credentials?: Record<string, string>;
  mockAgent?: boolean;
  defaultModel?: string;
  /** 百炼模型名（写入 BAILIAN_MODEL，聊天与联网检索均以此为准） */
  bailianModel?: string;
  /** DeepSeek 模型名（写入 DEEPSEEK_MODEL） */
  deepseekModel?: string;
  /** 本地音乐目录（写入 MUSIC_DIR）；空串表示回退到系统「音乐」目录 */
  musicDir?: string;
}

export function updateSettings(patch: SettingsPatch): SettingsView {
  let lines: string[] = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  }
  const lineKeyAt = new Map<number, string>();
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq === -1) return;
    lineKeyAt.set(i, t.slice(0, eq).trim());
  });

  const setVal = (key: string, value: string) => {
    let replaced = false;
    lineKeyAt.forEach((k, i) => {
      if (!replaced && k === key) {
        lines[i] = `${key}=${encodeEnv(value)}`;
        replaced = true;
      }
    });
    if (!replaced) {
      lines.push(`${key}=${encodeEnv(value)}`);
      lineKeyAt.set(lines.length - 1, key);
    }
    // 实时同步到当前进程环境，使配置立即生效（无需重启）
    process.env[key] = value;
  };

  const clearVal = (key: string) => {
    lineKeyAt.forEach((k, i) => {
      if (k === key) lines[i] = `${key}=`;
    });
    delete process.env[key];
  };

  // 1) 凭证（仅白名单字段）
  if (patch.credentials) {
    for (const def of CREDENTIAL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch.credentials, def.key)) {
        const val = String(patch.credentials[def.key] ?? '').trim();
        if (val) setVal(def.key, val);
        else clearVal(def.key);
      }
    }
  }

  // 2) 演示模式开关
  if (typeof patch.mockAgent === 'boolean') {
    setVal('MOCK_AGENT', patch.mockAgent ? '1' : '0');
  }

  // 3) 默认模型（CodeBuddy 兼容字段，保留向后兼容）
  if (typeof patch.defaultModel === 'string' && patch.defaultModel.trim()) {
    setVal('DEFAULT_MODEL', patch.defaultModel.trim());
  }

  // 4) 百炼模型（唯一真相源：聊天与联网检索均以此为准）
  if (typeof patch.bailianModel === 'string' && patch.bailianModel.trim()) {
    setVal('BAILIAN_MODEL', patch.bailianModel.trim());
  }

  // 5) DeepSeek 模型（唯一真相源：DEEPSEEK_MODEL）
  if (typeof patch.deepseekModel === 'string' && patch.deepseekModel.trim()) {
    setVal('DEEPSEEK_MODEL', patch.deepseekModel.trim());
  }

  // 6) 本地音乐目录（M 音乐能力）。传空串 = 清除，回退到系统「音乐」目录
  if (typeof patch.musicDir === 'string') {
    const v = patch.musicDir.trim();
    if (v) setVal('MUSIC_DIR', v);
    else clearVal('MUSIC_DIR');
  }

  // 4) 原子写回 .env
  const content = lines.join('\n').replace(/\n+$/, '') + '\n';
  const tmp = `${ENV_PATH}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, ENV_PATH);

  return getSettings();
}
