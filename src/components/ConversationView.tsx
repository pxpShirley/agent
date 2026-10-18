import { useMemo, memo } from 'react';
import MarkdownIt from 'markdown-it';
import type { Artifact, ChatMessage, PendingQuestion } from '../types';
import { OrbLogo } from './OrbLogo';
import { ConfirmCard } from './ConfirmCard';
import type { Decision } from './ConfirmCard';
import './XinglanConversation.css';

/* 助手输出按 Markdown 渲染：
   - html:false  —— 已对原始 HTML 做转义，杜绝注入；
   - breaks:true —— 保留换行，等价于此前的 white-space:pre-wrap；
   - linkify:true —— 纯文本链接可点；链接统一新标签打开并加 rel 防反向劫持。 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/**
 * 对话（重新设计）
 *
 * 只承载「当前这场对话」——不混入历史会话、不混入跨会话的记忆/提醒/产物。
 * 栖光做的每一件事（执行情况 / 执行结果 / 待你确认）都内联在它那条回复里，
 * 而不是塞进一条和旧账混在一起的"时间线"。历史通过 ⌘K 与「我的·灵境」访问。
 *
 * 视觉：左栖光 / 右气泡的双栏对话流；玻璃卡 + 冰青系统色，暖金仅留给"人的环"。
 */

const STEP_ROLE_LABEL: Record<string, string> = {
  planner: '规划',
  researcher: '研究',
  executor: '执行',
  critic: '复核',
};

const ART_TYPE_LABEL: Record<Artifact['type'], string> = {
  itinerary: '行程卡',
  report: '报告',
  checklist: '清单',
  note: '笔记',
};

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onNewChat: () => void;
  onConfirm?: (id: string, decision: Decision, value?: string) => void;
}

/**
 * ⚠️ 滚动纪律：本组件**不拥有滚动**。
 * 曾经这里也持有一个 ref 对 `.cv-scroll` 做 `scrollTo`，但 `.cv-scroll` 既没有
 * `overflow` 也没有 `flex:1`（见 XinglanConversation.css），那次滚动是 **no-op 死代码**，
 * 实际全靠父级 `.nx-chat-scroll` 碰巧生效 —— 注释还写着"与 Shell 错开避免双滚动源"，
 * 是纯粹的假象。现在滚动的唯一归属是 `XinglanShell` 的 `useStickToBottom`，
 * 本组件只负责渲染。改布局时若要让 `.cv-scroll` 自己滚，必须同步把滚动逻辑搬回来。
 */
export function ConversationView({ messages, onSend, onNewChat, onConfirm }: Props) {
  const rows = messages.filter((m) => m.role !== 'system');

  return (
    <div className="cv">
      <div className="cv-bar">
        <div className="cv-bar-title">
          <span className="cv-bar-dot" aria-hidden />
          与栖光对话
        </div>
        <button type="button" className="cv-new" onClick={onNewChat}>
          ＋ 新对话
        </button>
      </div>

      <div className="cv-scroll">
        {rows.map((m) =>
          m.role === 'user' ? (
            <UserRow key={m.id} m={m} />
          ) : (
            <AgentRow key={m.id} m={m} onSend={onSend} onConfirm={onConfirm} />
          )
        )}
        <div className="cv-tail" />
      </div>
    </div>
  );
}

const UserRow = memo(function UserRow({ m }: { m: ChatMessage }) {
  return (
    <div className="cv-row me">
      <div className="cv-avatar me" aria-hidden>
        你
      </div>
      <div className="cv-bubble me">
        <div className="cv-text">{m.content}</div>
        <span className="cv-ts">{hhmm(m.createdAt)}</span>
      </div>
    </div>
  );
});

const AgentRow = memo(function AgentRow({
  m,
  onSend,
  onConfirm,
}: {
  m: ChatMessage;
  onSend: (t: string) => void;
  onConfirm?: (id: string, decision: Decision, value?: string) => void;
}) {
  const steps = m.steps;
  const arts = m.artifacts;
  const pending = m.pendingQuestion as PendingQuestion | undefined;

  // 流式输出时不跑 markdown 解析（避免逐 token 重复解析整段回复），完成时再渲染一次。
  const isStreaming = !!m.isStreaming;
  const html = useMemo(() => (isStreaming ? '' : md.render(m.content || '')), [m.content, isStreaming]);

  return (
    <div className="cv-row agent">
      <div className="cv-avatar agent" aria-hidden>
        <OrbLogo size={30} />
      </div>
      <div className="cv-card">
        {m.isStreaming && !m.content ? (
          <div className="cv-thinking" aria-label="栖光正在思考">
            <span className="cv-thinking-dot" />
            <span className="cv-thinking-dot" />
            <span className="cv-thinking-dot" />
            栖光正在思考…
          </div>
        ) : isStreaming ? (
          <div className="cv-text cv-md">{m.content}</div>
        ) : (
          <div className="cv-text cv-md" dangerouslySetInnerHTML={{ __html: html }} />
        )}

        {/* —— 执行情况：本轮管家真实走过的动作 —— */}
        {steps && steps.length > 0 && (
          <div className="cv-steps" aria-label="执行情况">
            <div className="cv-steps-h">执行情况</div>
            {steps.map((s) => (
              <div
                key={s.id}
                className={`cv-step ${s.status === 'running' ? 'run' : 'done'}${s.error ? ' err' : ''}`}
              >
                <span className="cv-step-ico" aria-hidden>
                  {s.status === 'running' ? '' : s.error ? '!' : '✓'}
                </span>
                <span className="cv-step-name">{s.name}</span>
                {s.role && <span className="cv-step-role">{STEP_ROLE_LABEL[s.role] || s.role}</span>}
              </div>
            ))}
          </div>
        )}

        {/* —— 执行结果：本轮交付的结构化产物 —— */}
        {arts && arts.length > 0 && (
          <div className="cv-res" aria-label="执行结果">
            <div className="cv-res-h">执行结果</div>
            {arts.map((a) => (
              <div
                key={a.id}
                className="cv-artifact click"
                onClick={(e) => {
                  e.stopPropagation();
                  onSend(`打开产物《${a.title}》`);
                }}
              >
                <span className="cv-artifact-tag">{ART_TYPE_LABEL[a.type] || '产物'}</span>
                <div className="cv-artifact-main">
                  <div className="cv-artifact-t">{a.title}</div>
                  {a.content ? <div className="cv-artifact-d">{a.content.slice(0, 56)}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* —— 待你确认（已处理的决策记录）——
            待确认时不在这里渲染卡：在场舞台的「人的环」浮层是唯一确认入口，
            两份同现会让同一件事出现 8 个按钮（用户反馈过）。回答完在这里留结果。 */}
        {pending && onConfirm && pending.status !== 'pending' && (
          <div className="cv-pending">
            <ConfirmCard question={pending} onConfirm={onConfirm} />
          </div>
        )}

        <span className="cv-ts agent">{hhmm(m.createdAt)}</span>
      </div>
    </div>
  );
});

export default ConversationView;
