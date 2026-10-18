import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import type { SettingsView, Model, SettingsUpdate } from '../types';

const FALLBACK_MODELS: Model[] = [
  { modelId: 'qwen3.7-flash', name: 'qwen3.7-flash · 当前默认（快）' },
  { modelId: 'qwen-plus', name: 'qwen-plus · 均衡' },
  { modelId: 'qwen-max', name: 'qwen-max · 最强能力' },
  { modelId: 'qwen-turbo', name: 'qwen-turbo · 最便宜最快' },
  { modelId: 'qwen-long', name: 'qwen-long · 超长上下文' },
];

/**
 * 运行设置（关系界面内嵌）：引擎状态 / 凭证 / 运行模式 / 对话模型。
 * 复用 /api/settings 与 /api/models，保存后本进程即时生效（按供应商写入 DEEPSEEK_MODEL 或 BAILIAN_MODEL）。
 */
export function RuntimeSettings() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<Model[]>(FALLBACK_MODELS);

  const [credInputs, setCredInputs] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState<Record<string, boolean>>({});
  const [mockAgent, setMockAgent] = useState(false);
  const [bailianModel, setBailianModel] = useState('qwen3.7-flash');
  const [deepseekModel, setDeepseekModel] = useState('deepseek-chat');
  const [provider, setProvider] = useState<'deepseek' | 'bailian'>('bailian');
  const [providerLabel, setProviderLabel] = useState('百炼（通义千问）');

  const [echo, setEcho] = useState('');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  // 本地音乐（M 能力）：目录可改 + 一键扫描。文件永远留在原处，只索引路径。
  const [musicDir, setMusicDir] = useState('');
  const [musicCount, setMusicCount] = useState<number | null>(null);
  const [musicExists, setMusicExists] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');

  /** 读取音乐索引状态（目录是否存在 / 已索引多少首） */
  const loadMusicStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/music/status').then((x) => x.json());
      setMusicExists(!!r.exists);
      setMusicCount(typeof r.count === 'number' ? r.count : null);
      if (!r.exists && r.dir) setScanMsg(`目录不存在：${r.dir}`);
      else setScanMsg('');
    } catch {
      setMusicCount(null);
    }
  }, []);

  /** 扫描音乐目录（幂等）：只写索引，绝不移动/复制音频文件 */
  const onScanMusic = useCallback(async () => {
    setScanning(true);
    setScanMsg('扫描中…');
    try {
      const r = await fetch('/api/music/scan', { method: 'POST' }).then((x) => x.json());
      if (r.ok) {
        setMusicCount(r.total);
        setMusicExists(true);
        setScanMsg(`扫描完成：新增 ${r.added} 首，更新 ${r.updated} 首，清理 ${r.removed} 首，共 ${r.total} 首`);
      } else {
        setScanMsg(r.error || '扫描失败');
      }
    } catch (e: any) {
      setScanMsg(e?.message || '扫描失败');
    } finally {
      setScanning(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m] = await Promise.all([api.getSettings(), api.models()]);
      setSettings(s);
      setMockAgent(s.mockAgent);
      setBailianModel(s.bailianModel);
      setDeepseekModel(s.deepseekModel || 'deepseek-chat');
      if (s.chatProvider === 'deepseek' || s.chatProvider === 'bailian') setProvider(s.chatProvider);
      if (m.providerLabel) setProviderLabel(m.providerLabel);
      setModels(m.models && m.models.length ? m.models : FALLBACK_MODELS);
      setMusicDir(s.musicDir || '');
      setEcho('');
      loadMusicStatus();
    } catch (e: any) {
      setEcho(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setEcho('');
    try {
      const credentials: Record<string, string> = {};
      for (const c of settings.credentials) {
        const typed = credInputs[c.key] || '';
        const clr = !!clearing[c.key];
        if (clr) credentials[c.key] = '';
        else if (typed.trim()) credentials[c.key] = typed.trim();
      }
      const patch: SettingsUpdate = { credentials, mockAgent };
      // 只提交当前生效供应商的模型字段，避免两个供应商的模型名互相污染
      if (provider === 'deepseek') patch.deepseekModel = deepseekModel;
      else patch.bailianModel = bailianModel;
      // 音乐目录：允许传空串（清除 → 回退系统「音乐」目录）
      patch.musicDir = musicDir;
      const res = await api.updateSettings(patch);
      setSettings(res.settings);
      setCredInputs({});
      setClearing({});
      setMockAgent(res.settings.mockAgent);
      setBailianModel(res.settings.bailianModel);
      setDeepseekModel(res.settings.deepseekModel || 'deepseek-chat');
      setEcho(`已保存，${providerLabel}模型已即时生效，下一轮对话即使用新模型，无需重启服务。`);
    } catch (e: any) {
      setEcho(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [settings, credInputs, clearing, mockAgent, bailianModel, deepseekModel, provider, providerLabel, musicDir]);

  /**
   * 连通性自检：一次测两件事——对话引擎（DeepSeek/百炼）与联网检索源。
   * 原实现只测 CodeBuddy 登录，该接口已随 SDK 引擎一并移除。
   */
  const onTest = useCallback(async () => {
    setTestState('testing');
    setTestMsg('');
    try {
      const [eng, web] = await Promise.all([
        fetch('/api/check-engine').then((x) => x.json()).catch(() => ({})),
        fetch('/api/check-web').then((x) => x.json()).catch(() => ({})),
      ]);
      const parts: string[] = [];
      const engineOk = Boolean(eng?.configured && eng.ok);
      if (engineOk) parts.push(`引擎 ${eng.provider} / ${eng.model} 已连通（${eng.latencyMs}ms）`);
      else parts.push(`引擎未连通：${eng?.error || '未配置 DEEPSEEK_API_KEY 或 BAILIAN_API_KEY'}`);
      if (web?.configured && web.ok) parts.push(`联网 ${web.provider} 可用（${web.latencyMs}ms）`);
      else parts.push(`联网不可用：${web?.error || '未配置博查 / Tavily 等检索 Key'}`);
      setTestState(engineOk ? 'ok' : 'fail');
      setTestMsg(parts.join('；'));
    } catch (e: any) {
      setTestState('fail');
      setTestMsg(e?.message || '连接测试失败');
    }
  }, []);

  const engine = settings ? (settings.sdkActive ? 'sdk' : settings.mockAgent ? 'mock' : 'none') : 'none';
  /** 当前生效供应商对应的模型输入框取值 */
  const modelValue = provider === 'deepseek' ? deepseekModel : bailianModel;
  const engineMeta = {
    sdk: { label: '真实引擎已启用', cls: 'ok', desc: '由大模型实时驱动记忆 / 办事 / 晨报。' },
    mock: { label: '演示模式运行中', cls: 'warn', desc: '本地规则模拟管家，无需任何凭证即可体验完整管线。' },
    none: { label: '尚未启用任何引擎', cls: 'idle', desc: '配置凭证或打开演示模式后即可启用管家。' },
  }[engine];

  if (loading && !settings) {
    return <div className="gv-set-loading">加载中…</div>;
  }
  if (!settings) {
    return <div className="gv-set-loading">无法加载运行设置。</div>;
  }

  return (
    <div className="gv-set">
      {echo && <div className="gv-note">{echo}</div>}

      {/* 引擎状态 */}
      <section className="gv-sec">
        <div className="gv-sec-h">
          <span className="gv-sec-t">当前引擎</span>
        </div>
        <div className="gv-engine">
          <span className={`gv-pill ${engineMeta.cls}`}>{engineMeta.label}</span>
          <p className="gv-sec-desc">{engineMeta.desc}</p>
          <div className="gv-engine-actions">
            <button className="gv-btn ghost" type="button" onClick={onTest} disabled={testState === 'testing'}>
              {testState === 'testing' ? '测试中…' : '测试连通性'}
            </button>
            {testState !== 'idle' && (
              <span className={`gv-pill sm ${testState === 'ok' ? 'ok' : 'idle'}`}>
                {testState === 'ok' ? '✓ ' : '✕ '}
                {testMsg}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 凭证 */}
      <section className="gv-sec">
        <div className="gv-sec-h">
          <span className="gv-sec-t">智能引擎凭证</span>
          <span className="gv-sec-hint">密钥仅本地存储，接口返回脱敏视图</span>
        </div>
        <div className="gv-cred-list">
          {settings.credentials.map((c) => {
            const typed = credInputs[c.key] || '';
            const clr = !!clearing[c.key];
            return (
              <div className="gv-cred" key={c.key}>
                <div className="gv-cred-top">
                  <span className="gv-cred-label">{c.label}</span>
                  <span className={`gv-pill sm ${c.set ? 'ok' : 'idle'}`}>
                    {c.set ? `已配置${c.preview ? ' · ' + c.preview : ''}` : '未配置'}
                  </span>
                </div>
                <input
                  className="gv-input"
                  type="password"
                  autoComplete="off"
                  placeholder={clr ? '将清除该凭证' : c.placeholder}
                  value={typed}
                  onChange={(e) => setCredInputs((p) => ({ ...p, [c.key]: e.target.value }))}
                />
                <div className="gv-cred-foot">
                  <span className="gv-cred-hint">{c.hint}</span>
                  {c.set && (
                    <button
                      className="gv-link"
                      type="button"
                      onClick={() => setClearing((p) => ({ ...p, [c.key]: !clr }))}
                    >
                      {clr ? '取消清除' : '清除凭证'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 运行模式 */}
      <section className="gv-sec">
        <div className="gv-sec-h">
          <span className="gv-sec-t">运行模式</span>
        </div>
        <div className="gv-mode-list">
          <div className="gv-mode">
            <div className="gv-mode-top">
              <span className="gv-cred-label">演示模式（MOCK）</span>
              <button
                type="button"
                className={`gv-switch ${mockAgent ? 'on' : ''}`}
                role="switch"
                aria-checked={mockAgent}
                onClick={() => setMockAgent((v) => !v)}
              >
                <span className="gv-switch-knob" />
              </button>
            </div>
            <p className="gv-cred-hint">
              开启后无需任何凭证即可跑通完整管线（本地规则）。若同时配置了凭证，演示模式优先；关闭后切换为真实引擎。
            </p>
          </div>

          <div className="gv-mode">
            <div className="gv-mode-top">
              <span className="gv-cred-label">对话模型（{providerLabel}）</span>
              <span className={`gv-pill sm ${modelValue ? 'ok' : 'idle'}`}>{modelValue || '未设置'}</span>
            </div>
            <input
              className="gv-input"
              list="chat-models"
              value={modelValue}
              placeholder={provider === 'deepseek' ? '如 deepseek-chat' : '如 qwen-max / qwen-turbo'}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => (provider === 'deepseek' ? setDeepseekModel(e.target.value) : setBailianModel(e.target.value))}
            />
            <datalist id="chat-models">
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.name}
                </option>
              ))}
            </datalist>
            <p className="gv-cred-hint">
              当前生效供应商为 <b>{providerLabel}</b>（配了 DEEPSEEK_API_KEY 时优先 DeepSeek，否则用百炼）。聊天与联网检索均以此模型为准；可直接输入其他模型名。保存后下一轮对话即生效。
              <br />
              {provider === 'deepseek'
                ? 'DeepSeek 走 OpenAI 兼容协议，支持工具调用；deepseek-reasoner 为推理型，速度较慢且不支持工具调用，建议日常用 deepseek-chat。'
                : '注：百炼当前账号为免费额度，仅 qwen3.7-flash / qwen-turbo 等可用；qwen-max、qwen-plus 等需开通付费额度，否则会 403 并自动回退演示模式。'}
            </p>
          </div>
        </div>
      </section>

      {/* 本地音乐（M 能力） */}
      <section className="gv-sec">
        <div className="gv-sec-h">
          <span className="gv-sec-t">本地音乐</span>
          <span className="gv-pill sm">
            {musicCount === null ? '未索引' : musicExists ? `已索引 ${musicCount} 首` : '目录不存在'}
          </span>
        </div>
        <div className="gv-cred">
          <label className="gv-cred-label" htmlFor="music-dir">
            音乐目录
          </label>
          <input
            id="music-dir"
            className="gv-input"
            value={musicDir}
            placeholder="留空则使用系统「音乐」目录，如 C:\Users\你的名字\Music"
            spellCheck={false}
            onChange={(e) => setMusicDir(e.target.value)}
          />
          <div className="gv-cred-actions">
            <button className="gv-btn ghost" type="button" onClick={onScanMusic} disabled={scanning}>
              {scanning ? '扫描中…' : '扫描目录'}
            </button>
          </div>
          <p className="gv-cred-hint">
            栖光只读取这个目录里的音频（mp3 / flac / wav / m4a / ogg），建一份路径索引用来选曲。
            <b>文件永远留在原处</b>——不复制、不入库、不上传；索引里的条目删掉也不会动你的歌。
            {scanMsg ? ` ${scanMsg}` : ''}
          </p>
        </div>
      </section>

      {/* 提示 */}
      {settings.notes.length > 0 && (
        <section className="gv-sec">
          <div className="gv-sec-h">
            <span className="gv-sec-t">提示</span>
          </div>
          <ul className="gv-notes">
            {settings.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {/* 保存栏 */}
      <div className="gv-savebar">
        <span className="gv-save-hint">保存后无需重启，配置在本进程内即时生效。</span>
        <div className="gv-save-actions">
          <button className="gv-btn ghost" type="button" onClick={load} disabled={saving}>
            重置
          </button>
          <button className="gv-btn primary" type="button" onClick={onSave} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RuntimeSettings;
