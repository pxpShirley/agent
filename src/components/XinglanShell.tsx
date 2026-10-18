import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage, AgentContext, PendingQuestion, SessionSummary, ProactiveCard } from '../types';
import { APP_CONFIG } from '../config';

import type { CoreState, AgentPhase } from './XinglanCore';
import type { XinglanMood } from './StarSprite';
import { XinglanCore } from './XinglanCore';
import { StarSprite } from './StarSprite';
import { ConversationView } from './ConversationView';
import { Composer } from './Composer';
import { ConfirmCard } from './ConfirmCard';
import type { Decision } from './ConfirmCard';
import { DashboardPanel } from './DashboardPanel';
import { OrbLogo } from './OrbLogo';
import { GovernanceLayer } from './GovernanceLayer';
import { MoodPalette } from './MoodPalette';
import { useVoiceInput } from './useVoiceInput';
import { useXinglanPerformance } from '../hooks/useXinglanPerformance';
import { useNow } from '../hooks/useNow';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { MOOD_LABEL } from '../utils/xinglanMood';
import { getGreeting, getDailyBrief, CAPABILITIES } from '../utils/butler';
import { CapIcon } from './CapIcon';
import { CommandPalette } from './CommandPalette';
import { MusicPlayer } from './MusicPlayer';

import './xinglan.css';

type Accent = 'nebula' | 'warm';
/* v2.3 IA：左 presence 常驻（栖光 + 星轨 + 人的时刻浮层）；右 side-views 切换
   主页(对话+感知流) / 我的(灵境) / 历史(侧视图) / 治理。能力溶解为内联 chips + ⌘K。 */
type View = 'home' | 'dashboard' | 'governance' | 'music';

interface Props {
  accent: Accent;
  lite: boolean;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  messages: ChatMessage[];
  context: AgentContext | null;
  loading: boolean;
  pendingQ: PendingQuestion | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onConfirm: (id: string, decision: Decision, value?: string) => void;
  onToggleAccent: () => void;
  onToggleLite: () => void;
  connected: boolean | null;
  offline: boolean;
  onReconnect: () => void;
  notice: string | null;
  onDismissNotice: () => void;
  sessions: SessionSummary[];
  onNewChat: () => void;
  proactive: ProactiveCard | null;
  onProactiveAccept: (id: string) => void;
  onProactiveDismiss: (id: string) => void;
  /** A4：执行主动卡内联动作（complete/snooze 走后端；ask_agent/open_view 前端处理） */
  onProactiveAction?: (id: string, type: string) => void;
  /** 用户在「我的·灵境」改动记忆/提醒后，刷新上下文 */
  onContextChanged?: () => void;
}

const PROACTIVE_KIND_LABEL: Record<string, string> = {
  morning: '晨报',
  reminder_due: '到期提醒',
  weekly: '周复盘',
  nudge: '关怀',
};

const ICON = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h16v11H9l-5 4z" /><path d="M8 10h8M8 13h5" /></svg>,
  dash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>,
  gov: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  accent: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17c-2 0-3-1.5-3-3 0-1.5 1-2 1-3 0-1.5-1-2-1-3 0-1.5 1-2 3-2z" /></svg>,
  lite: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg>,
  music: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></svg>,
};

/** 人的时刻感知条：日期 · 此刻 · 待办 · 记忆 —— 欢迎空态下的"管家在场感" */
function MomentBar({ context, dateText }: { context: AgentContext | null; dateText: string }) {
  // 必须是会走的时间：这里曾经直接 new Date() 算一次就不动了，
  // 一个标着「此刻」的条子永远停在打开页面那一刻。
  const d = useNow();
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const open = (context?.reminders || []).filter((r) => r.done !== 1).length;
  const mem = context?.memories?.length || 0;
  const dot = <span className="nx-moment-dot" aria-hidden />;
  return (
    <div className="nx-moment-bar" aria-label="此刻感知">
      <span>{dateText}</span>
      {dot}
      <span>此刻 <b>{hhmm}</b></span>
      {dot}
      <span>待办 <b>{open}</b></span>
      {dot}
      <span>记忆 <b>{mem}</b></span>
    </div>
  );
}

/**
 * 导航项。
 *
 * ⚠️ 曾经把播放/暂停做成 `<span role="button" tabIndex={0}>` **嵌在 button 内部**——
 * 嵌套可交互元素是非法结构（读屏会读出两个控件、键盘 Tab 序错乱），
 * 只能靠 `e.stopPropagation()` 打补丁。现在 eq 是**兄弟节点**的真 `<button>`：
 * 状态（active / playing）提到外层 `.nx-rail-wrap` 上，eq 绝对定位回图标右下角，
 * 视觉不变但结构合法、`stopPropagation` 补丁全部删掉。
 */
function RailButton({ icon, label, onClick, active, badge, dot, playing, showEq, onTogglePlay, title }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean; badge?: boolean; dot?: boolean; playing?: boolean; showEq?: boolean; onTogglePlay?: () => void; title?: string }) {
  return (
    <div className={`nx-rail-wrap${active ? ' active' : ''}${playing ? ' playing' : ''}`}>
      <button type="button" className="nx-rail-btn" onClick={onClick} title={title} aria-label={label} aria-current={active ? 'page' : undefined}>
        <span className="nx-rail-ico">
          {icon}
          {badge && <span className="nx-rail-badge" aria-hidden />}
          {dot && <span className="nx-rail-dot" aria-hidden />}
        </span>
        <span>{label}</span>
      </button>
      {showEq && (
        <button
          type="button"
          className="nx-rail-eq"
          onClick={onTogglePlay}
          aria-label={playing ? '暂停播放' : '继续播放'}
          title={playing ? '暂停' : '继续播放'}
        >
          <i /><i /><i />
        </button>
      )}
    </div>
  );
}

/**
 * 折起来的栖光：非「此刻」视图下的**常驻在场球**。
 *
 * 为什么需要它：舞台曾经写成 `view === 'home' && <section className="nx-presence">`，
 * 于是切到「我的 / 治理 / 音乐」时栖光被整块卸载——"从占屏退为在场"被实现成了
 * "切走就不在场"。现在同一个形象、同一条情绪时间线（`mood` 由 Shell 层的
 * useXinglanPerformance 持续推导，不受 view 影响），只是换了个尺寸：
 * 你看别处时它仍在这儿，点一下回到完整舞台。
 */
function PresenceOrb({ accent, mood, speaking, waiting, label, onBack }: {
  accent: Accent;
  mood: XinglanMood;
  speaking: boolean;
  waiting: boolean;
  label: string;
  onBack: () => void;
}) {
  return (
    <button
      type="button"
      className={`nx-presence-orb${waiting ? ' waiting' : ''}`}
      onClick={onBack}
      title={`栖光 · ${waiting ? '等你确认' : label}　（回到此刻）`}
      aria-label={`栖光，${waiting ? '等你确认' : label}，回到此刻`}
    >
      <span className="nx-presence-orb-glow" aria-hidden />
      <StarSprite accent={accent} mood={mood} speaking={speaking} waiting={waiting} size={54} />
      <span className="nx-presence-orb-lab">{waiting ? '等你' : label}</span>
    </button>
  );
}

export function XinglanShell({
  accent,
  lite,
  theme = 'dark',
  onToggleTheme,
  messages,
  context,
  loading,
  pendingQ,
  onSend,
  onStop,
  onConfirm,
  onToggleAccent,
  onToggleLite,
  connected,
  offline,
  onReconnect,
  notice,
  onDismissNotice,
  sessions,
  onNewChat,
  proactive,
  onProactiveAccept,
  onProactiveDismiss,
  onProactiveAction,
  onContextChanged,
}: Props) {
  const [view, setView] = useState<View>('home');
  const [moodManual, setMoodManual] = useState<XinglanMood | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [musicState, setMusicState] = useState<{ playing: boolean; title: string }>({ playing: false, title: '' });
  /** 调试入口：?lab=1 才显示手动情绪板等内部控件 */
  const labMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('lab') === '1';

  /* 统一"开口"入口：所有触发（输入 / 建议 / 能力 / 主动卡 / 语音）经此汇入 */
  const dispatch = useCallback(
    (text: string) => {
      const t = (text || '').trim();
      if (!t) return;
      setView('home');
      onSend(t);
    },
    [onSend],
  );

  const voice = useVoiceInput({
    warm: accent === 'warm',
    onTranscript: (text, isFinal) => { if (isFinal && text.trim()) dispatch(text.trim()); },
  });

  const isStreaming = messages.some((m) => m.isStreaming);
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant'), [messages]);
  const hasMessages = messages.length > 0;

  const state: CoreState = loading ? 'thinking' : isStreaming ? 'speaking' : voice.recording ? 'listening' : 'idle';
  const waiting = !!pendingQ;
  /** 执行链里还有步骤在跑 —— 形象该"在想"，哪怕这一刻没有流式文本 */
  const agentBusy = !!lastAssistant?.steps?.some((s) => s.status === 'running');

  // 演出编排：把机械的加载标志翻译成有起伏的情绪时间线
  // （待你确认 → 聆听 → 思考 → 诉说 → 送达定格 happy/concerned → 静候 → 久了安睡）
  const perf = useXinglanPerformance({
    loading,
    streaming: isStreaming,
    recording: voice.recording,
    waiting,
    agentBusy,
    lastText: lastAssistant?.content || '',
    lastTextKey: lastAssistant?.id,
    // 精简模式下不安睡：性能模式要的是"别动"，睡着反而更像卡住
    sleepEnabled: !lite,
  });
  const mood: XinglanMood = moodManual ?? perf.mood;
  /** 状态文案必须描述"脸上此刻的表情"，所以手动覆写时也要跟着走 */
  const moodLabel = MOOD_LABEL[mood];

  const caption = lastAssistant?.content
    ? lastAssistant.content.length > 52 ? lastAssistant.content.slice(0, 52) + '…' : lastAssistant.content
    : '';

  const { agentPhase, agentDetail } = useMemo(() => {
    const ph: Partial<Record<string, AgentPhase>> = {};
    const dt: Partial<Record<string, string>> = {};
    const steps = lastAssistant?.steps || [];
    for (const s of steps) {
      const role = s.role || '';
      if (!role) continue;
      ph[role] = s.status === 'running' ? 'active' : 'done';
      dt[role] = s.name;
    }
    return { agentPhase: ph, agentDetail: dt };
  }, [lastAssistant]);

  const openGoals = (context?.reminders || []).filter((r) => r.done !== 1).length;
  const energy = Math.min(1, openGoals / 5);

  const greeting = useMemo(() => getGreeting(), []);
  const briefRows = useMemo(() => getDailyBrief(new Date(), context), [context]);
  const homeCaps = CAPABILITIES.slice(0, 4);

  /**
   * 对话滚动：唯一滚动源是 `.nx-chat-scroll`（ConversationView 内部不再自己滚，
   * 它那个 ref 曾经是死代码——见 ConversationView 的注释）。
   * 跟随是有条件的：用户往上翻看历史时不再把他拽回底部，改为提示「回到最新」。
   */
  const { ref: chatScrollRef, pinned, stick } = useStickToBottom<HTMLDivElement>(messages);

  // ⌘K 打开命令面板；Esc 优先关浮层（命令面板 → 回主页）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      if (e.key === 'Escape') {
        if (cmdOpen) { setCmdOpen(false); return; }
        if (view !== 'home') setView('home');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cmdOpen, view]);

  const runCommand = (text: string) => {
    setCmdOpen(false);
    dispatch(text);
  };

  return (
    <div className={`nx-shell accent-${accent}${lite ? ' lite' : ''}${offline ? ' is-offline' : ''}`}>
      <div className="nx-aurora" aria-hidden />

      {/* —— 左侧导航 Rail —— */}
      <aside className="nx-rail">
        <div className="nx-rail-brand">
          <OrbLogo size={34} className="nx-rail-logo" />
          <span className="nx-rail-name">{APP_CONFIG.name}</span>
        </div>

        <nav className="nx-rail-nav">
          <RailButton icon={ICON.home} label="此刻" active={view === 'home'} onClick={() => setView('home')} badge={waiting} dot={!!proactive} title="共同时光线" />
          <RailButton icon={ICON.dash} label="我的" active={view === 'dashboard'} onClick={() => setView('dashboard')} title="我的 · 灵境" />
          <RailButton icon={ICON.gov} label="治理" active={view === 'governance'} onClick={() => setView('governance')} title="治理与设置" />
          <RailButton icon={ICON.music} label="音乐" active={view === 'music'} onClick={() => setView('music')} playing={musicState.playing} showEq={!!musicState.title} title={musicState.playing ? `正在播放：${musicState.title}` : (musicState.title ? `已暂停：${musicState.title}` : '本地音乐')} onTogglePlay={() => window.dispatchEvent(new CustomEvent('xl-music-control', { detail: { action: musicState.playing ? 'pause' : 'resume' } }))} />
        </nav>

        <div className="nx-rail-foot">
          <RailButton icon={ICON.accent} label={accent === 'warm' ? '暖金' : '青蓝'} onClick={onToggleAccent} active={accent === 'warm'} title="切换配色" />
          <RailButton icon={ICON.lite} label="精简" onClick={onToggleLite} active={lite} title="切换性能模式" />
        </div>
      </aside>

      {/* —— 主区域 —— */}
      <div className="nx-main">
        <header className="nx-top">
          <div className="nx-greet">
            <h1 className="nx-greet-h">{greeting.hello}</h1>
            <span className="nx-greet-sub">{greeting.sub} · {APP_CONFIG.description}</span>
          </div>
          <div className="nx-top-right">
            <button type="button" className="nx-cmdk-btn" onClick={() => setCmdOpen(true)} title="唤起能力 (⌘K)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" />
              </svg>
              <span>唤起能力</span>
              <kbd>⌘K</kbd>
            </button>
            <div className={`nx-status${connected === false ? ' off' : ''}`} title={connected === false ? '离线' : '在线'}>
              <span className="nx-dot" />
              {connected === false ? '离线' : '在线'}
            </div>
          </div>
        </header>

        {/* —— 反馈栈：所有「告知型」通知的唯一容器 ——
            以前 notice 在顶、offline 在底、需要你浮在中层，三种通知三种定位方式，
            再加第四种必然要重新挑地方、和已有的抢位置。现在状态类统一进这一个竖排栈：
            留白与间距归栈管，子节点只管自己的配色，新增通知 = 多一个子节点。
            「需要你」的暖金条不进来 —— 那是中断，不是告知，优先级更高（见 .nx-needy-float）。 */}
        {(notice || offline) && (
          <div className="nx-feedback" role="status" aria-live="polite">
            {notice && (
              <div className="nx-inline-notice">
                <span className="nx-inline-notice-text">{notice}</span>
                <button type="button" className="nx-inline-notice-x" onClick={onDismissNotice} aria-label="关闭通知">×</button>
              </div>
            )}
            {offline && (
              <div className="nx-inline-offline">
                栖光暂时离线，已为你保留对话
                <button type="button" className="nx-inline-offline-btn" onClick={onReconnect}>重新连接</button>
              </div>
            )}
          </div>
        )}

        {/* —— 舞台：左 presence 常驻 + 右 side-views —— */}
        <div className={`nx-stage-body${view === 'home' ? '' : ' wide'}`}>
          {/* 左：栖光在场舞台 —— 「此刻」是完整舞台，其余视图折成常驻在场球 */}
          {view === 'home' ? (
          <section className={`nx-presence${waiting ? ' hm-open' : ''}`} aria-label="栖光在场舞台">
            <XinglanCore
              state={state}
              energy={energy}
              attention={waiting}
              waiting={waiting}
              accent={accent}
              mood={mood}
              stateLabel={moodLabel}
              caption={caption}
              agentPhase={agentPhase}
              agentDetail={agentDetail}
            />
            {/* 手动调情绪只在调试入口出现（?lab=1）：你能给它设"开心"的那一刻，就等于承认情绪是表演 */}
            {labMode && (
              <div className="nx-presence-mood">
                <MoodPalette value={moodManual} onChange={setMoodManual} />
              </div>
            )}

            {/* 人的时刻：pendingQ 居中暖金浮层（取代对话流内联确认卡） */}
            {pendingQ && (
              <div className="nx-human-moment show" role="dialog" aria-label="需要你的决策">
                <ConfirmCard question={pendingQ} onConfirm={onConfirm} />
              </div>
            )}
          </section>
          ) : (
            <PresenceOrb
              accent={accent}
              mood={mood}
              speaking={state === 'speaking'}
              waiting={waiting}
              label={moodLabel}
              onBack={() => setView('home')}
            />
          )}

          {/* 非「此刻」视图下 pendingQ 无处安放 —— 用顶部金色条把人叫回来 */}
          {waiting && view !== 'home' && (
            <button type="button" className="nx-needy-bar nx-needy-float" onClick={() => setView('home')}>
              <span className="nx-needy-dot" aria-hidden />
              栖光需要你确认一件事 · 去看看
            </button>
          )}

          {/* 右：side-views —— 主页是「共同时光线」，不再是聊天流 */}
          <section className="nx-side">
            {/* —— 主页：共同时光线（对话只是往线上追加事件的一种方式） —— */}
            <div className={`nx-side-view${view === 'home' ? ' on' : ''}`} aria-label="主页">
              <div className="nx-home-chat">
                {hasMessages && !pinned && (
                  <button type="button" className="nx-jump-latest" onClick={stick}>
                    ↓ 回到最新
                  </button>
                )}
                <div className="nx-chat-scroll" ref={chatScrollRef}>
                  {!hasMessages ? (
                    <div className="nx-welcome">
                      <div className="nx-welcome-h">{greeting.hello}，我是{APP_CONFIG.name}</div>
                      <div className="nx-welcome-sub">栖光在这儿，随时听你吩咐。说点什么，交给我来做。</div>
                      <MomentBar context={context} dateText={greeting.sub} />
                      {/* 空态必须给抓手：不然新用户只知道"有个 AI"，不知道能让它干什么。
                          这几张卡把「能做什么」变成可点的一句话，点了就直接进对话。 */}
                      <div className="nx-welcome-caps" aria-label="可以先试试这些">
                        {homeCaps.map((c) => (
                          <button key={c.id} type="button" className="nx-welcome-cap" onClick={() => dispatch(c.prompt)}>
                            <span className="nx-welcome-cap-ico" aria-hidden><CapIcon name={c.icon} size={18} /></span>
                            <span className="nx-welcome-cap-t">{c.title}</span>
                            <span className="nx-welcome-cap-d">{c.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <ConversationView
                      messages={messages}
                      onSend={dispatch}
                      onNewChat={onNewChat}
                      onConfirm={onConfirm}
                    />
                  )}
                </div>

                <div className="nx-chat-foot">
                  {voice.recording && (
                    <div className="nx-wave">
                      <canvas ref={voice.waveRef} className="xl-wave-canvas" />
                    </div>
                  )}
                  <div className="nx-foot-row">
                    <button
                      type="button"
                      className={`nx-mic${voice.recording ? ' recording' : ''}`}
                      onClick={voice.toggle}
                      title="语音输入"
                      aria-label="语音输入"
                    >
                      {voice.recording ? '■' : '🎙'}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Composer
                        loading={loading}
                        placeholder="有什么想交给栖光的？"
                        onSend={dispatch}
                        onStop={onStop}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* —— 我的（灵境） —— */}
            <div className={`nx-side-view${view === 'dashboard' ? ' on' : ''}`} aria-label="我的灵境">
              <div className="nx-sv-head"><div className="nx-sv-title">灵境 · 我的</div></div>
              <div className="nx-side-panel">
                <DashboardPanel context={context} messages={messages} onSend={dispatch} onChanged={onContextChanged} />
              </div>
            </div>

            {/* 历史抽屉已删除：过去的会话是时间线上的一段，不是一个侧视图 */}

            {/* —— 治理 —— */}
            <div className={`nx-side-view${view === 'governance' ? ' on' : ''}`} aria-label="治理">
              <div className="nx-sv-head"><div className="nx-sv-title">治理 · 栖光的透明度</div></div>
              <div className="nx-side-panel">
                <GovernanceLayer theme={theme} onToggleTheme={onToggleTheme || (() => {})} onClose={() => setView('home')} initialTab="supervise" />
              </div>
            </div>

            {/* —— 音乐（本地曲库）: 独立页面，不在底部挂浮层。
                 栖光可在聊天里发起播放；播放器始终挂载于此 side-view（仅显隐切换），
                 故切走其他视图音频不中断。 */}
            <div className={`nx-side-view${view === 'music' ? ' on' : ''}`} aria-label="本地音乐">
              <div className="nx-sv-head"><div className="nx-sv-title">音乐 · 本地曲库</div></div>
              <div className="nx-side-panel">
                <MusicPlayer page onState={setMusicState} />
              </div>
            </div>
          </section>
        </div>

        {/* —— 底部停靠区：主动卡 / 正在播放 竖排，共享同一锚点，互不遮挡 ——
            以前播放器是 fixed 独立的，和主动卡抢同一片底部空间（主动卡 z-index 更高，
            会把播放器压在下面看不见也点不到）。现在统一进停靠区，靠 flex column 竖排。 */}
        <div className="xl-bottom-dock">
          {/* —— A4 主动卡浮卡：管家"不用你开口"也替你盯着的事，可内联动作 ——
              待你确认时让位：「人的环」是当时的唯一主角，不跟它抢位置 */}
          {proactive && view === 'home' && !waiting && (
            <div className="xl-proactive" role="complementary" aria-label="栖光的主动提醒">
            <div className="xl-proactive-head">
              <span className="xl-proactive-kind">
                <span className="xl-proactive-ico" aria-hidden>✦</span>
                {PROACTIVE_KIND_LABEL[proactive.kind] || proactive.kind}
              </span>
              <button
                type="button"
                className="xl-proactive-x"
                onClick={() => onProactiveDismiss?.(proactive.id)}
                aria-label="忽略这条提醒"
                title="忽略"
              >
                ×
              </button>
            </div>
            <div className="xl-proactive-title">{proactive.title}</div>
            {proactive.body && <div className="xl-proactive-body">{proactive.body}</div>}
            <div className="xl-proactive-actions">
              {(proactive.actions || []).map((a) => {
                const isPrimary = a.type === 'complete';
                const cls = `xl-proactive-act${isPrimary ? ' primary' : ''}`;
                const onClick = () => {
                  if (a.type === 'ask_agent') {
                    onProactiveAction?.(proactive.id, a.type);
                    dispatch(a.payload?.prompt || '帮我看看');
                  } else if (a.type === 'open_view') {
                    onProactiveAction?.(proactive.id, a.type);
                    if (a.payload?.view) setView(a.payload.view as View);
                  } else {
                    onProactiveAction?.(proactive.id, a.type);
                  }
                };
                return (
                  <button key={a.type} type="button" className={cls} onClick={onClick}>
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* —— 正在播放：栖光在对话里放的歌，切到任何视图都该看得见、管得着 ——
               以前只有导航栏上 3 根小均衡器，切到「此刻」就两眼一抹黑：
               不知道在放什么，也没法暂停。音乐页本身有完整播放器，故不重复。 */}
          {musicState.title && view !== 'music' && (
            <div className="xl-now-playing" role="status" aria-label="正在播放">
              <span className={`xl-np-eq${musicState.playing ? ' on' : ''}`} aria-hidden><i /><i /><i /></span>
              <span className="xl-np-t" title={musicState.title}>{musicState.title}</span>
              <button
                type="button"
                className="xl-np-btn"
                onClick={() => window.dispatchEvent(new CustomEvent('xl-music-control', { detail: { action: musicState.playing ? 'pause' : 'resume' } }))}
                title={musicState.playing ? '暂停' : '继续播放'}
              >
                {musicState.playing ? '暂停' : '继续'}
              </button>
              <button type="button" className="xl-np-btn" onClick={() => setView('music')} title="打开播放器">播放器</button>
            </div>
          )}
        </div>
      </div>

      {/* ⌘K 命令面板（跨 能力 / 记忆 / 历史 统一检索与发起） */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onPick={runCommand}
        context={context}
        sessions={sessions}
      />
    </div>
  );
}

export default XinglanShell;
