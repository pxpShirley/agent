import type { Express } from 'express';
import { isDeepSeekConfigured, isCompatEngineConfigured, getChatModel, getSettings, updateSettings, BAILIAN_MODELS, DEEPSEEK_MODELS } from '../settings.js';
import { pingCompatEngine } from '../llm/bailian.js';
import { pingWebSearch } from '../tools/web.js';
import * as db from '../db.js';
import { notifyChanged } from '../realtime.js';
import { ctrlOwner, serializeMessage } from './shared.js';

export function registerMeta(app: Express): void {
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.get('/api/models', async (_req, res) => {
  // 按当前生效供应商返回可选模型清单（DeepSeek 优先，其次百炼）
  const provider: 'deepseek' | 'bailian' = isDeepSeekConfigured() ? 'deepseek' : 'bailian';
  const models = provider === 'deepseek' ? DEEPSEEK_MODELS : BAILIAN_MODELS;
  try {
    res.json({
      models,
      defaultModel: getChatModel(),
      provider,
      providerLabel: provider === 'deepseek' ? 'DeepSeek' : '百炼（通义千问）',
    });
  } catch (error: any) {
    res.json({
      models,
      defaultModel: getChatModel(),
      provider,
      providerLabel: provider === 'deepseek' ? 'DeepSeek' : '百炼（通义千问）',
      error: error?.message || String(error),
    });
  }
});

// 对话引擎连通性自检：轻量打一次真实请求，返回供应商 / 模型 / 延迟 / 错误
app.get('/api/check-engine', async (_req, res) => {
  if (!isCompatEngineConfigured()) {
    res.json({
      ok: false,
      configured: false,
      error: '未配置 DEEPSEEK_API_KEY 或 BAILIAN_API_KEY，当前不会走真实大模型。',
    });
    return;
  }
  try {
    const r = await pingCompatEngine();
    res.json({ configured: true, ...r });
  } catch (e: any) {
    res.json({ configured: true, ok: false, error: e?.message || String(e) });
  }
});


// 联网能力自检：实打一次当前生效的检索源，返回源 / 延迟 / 错误
app.get('/api/check-web', async (_req, res) => {
  try {
    res.json(await pingWebSearch());
  } catch (e: any) {
    res.json({ provider: '-', configured: false, ok: false, latencyMs: 0, error: e?.message || String(e) });
  }
});

// 运行设置：自助配置凭证 / 演示模式 / 默认模型（脱敏只读，写入即时生效，无需重启）
app.get('/api/settings', (_req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const patch = req.body || {};
    const clean: {
      credentials?: Record<string, string>;
      mockAgent?: boolean;
      defaultModel?: string;
      bailianModel?: string;
      deepseekModel?: string;
      /** 本地音乐目录（M 音乐能力）：空串表示回退到系统「音乐」目录 */
      musicDir?: string;
    } = {};
    if (patch.credentials && typeof patch.credentials === 'object') clean.credentials = patch.credentials;
    if (typeof patch.mockAgent === 'boolean') clean.mockAgent = patch.mockAgent;
    if (typeof patch.defaultModel === 'string') clean.defaultModel = patch.defaultModel;
    if (typeof patch.bailianModel === 'string' && patch.bailianModel.trim()) clean.bailianModel = patch.bailianModel.trim();
    if (typeof patch.deepseekModel === 'string' && patch.deepseekModel.trim()) clean.deepseekModel = patch.deepseekModel.trim();
    // 音乐目录允许传空串（= 清除并回退系统目录），故只校验类型不校验非空
    if (typeof patch.musicDir === 'string') clean.musicDir = patch.musicDir;
    const settings = updateSettings(clean);
    res.json({ success: true, settings });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '保存失败' });
  }
});
}
