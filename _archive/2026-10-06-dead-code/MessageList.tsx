import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { renderMarkdown, formatTime } from '../utils/format';
import { IntentBadge } from './Badges';
import { OrbLogo } from './OrbLogo';
import { AgentSteps } from './AgentSteps';
import { ConfirmCard } from './ConfirmCard';
import { ArtifactCard } from './ArtifactCard';

/** 复制原文（含 Markdown 源码，便于复用）；非安全上下文回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 悬停/聚焦才出现的复制按钮 */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCopy = async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1600);
  };

  return (
    <button
      type="button"
      className={`msg-copy${done ? ' done' : ''}`}
      onClick={onCopy}
      title={done ? '已复制' : '复制这条消息'}
      aria-label={done ? '已复制' : '复制这条消息'}
    >
      {done ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12.5l5 5L20 6.5" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" /></svg>
      )}
      <span>{done ? '已复制' : '复制'}</span>
    </button>
  );
}

interface Props {
  messages: ChatMessage[];
  loading: boolean;
  showMeta?: boolean;
  /** 确认卡已在核心旁焦点层展示时，流内不再重复渲染 */
  suppressPending?: boolean;
  onConfirmQuestion?: (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel', value?: string) => void;
}

export function MessageList({ messages, loading, showMeta = true, suppressPending = false, onConfirmQuestion }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  return (
    <div className="flex flex-col gap-5">
      {messages.map((msg) => {
        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="flex justify-center">
              <div
                className="max-w-[85%] text-center text-xs px-4 py-2 rounded-lg leading-relaxed"
                style={{ backgroundColor: 'rgba(124,140,255,0.12)', color: '#9aa6ff' }}
              >
                {msg.content}
              </div>
            </div>
          );
        }

        const isUser = msg.role === 'user';
        return (
          <div key={msg.id} className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
            <div
              className={`msg-avatar w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5 ${isUser ? 'me' : ''}`}
            >
              {isUser ? '我' : <OrbLogo size={22} />}
            </div>

            <div className={`msg-col max-w-[76%] min-w-0 flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
              <div
                className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words chat-bubble ${isUser ? 'msg-me' : 'msg-agent'}`}
              >
                {isUser ? (
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                ) : msg.content ? (
                  <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                ) : (
                  <span className="inline-flex gap-1 py-1 typing-dots">
                    <i /> <i /> <i />
                  </span>
                )}
                {msg.isStreaming && msg.content ? <span className="stream-cursor" /> : null}
              </div>

              {msg.pendingQuestion && onConfirmQuestion && !suppressPending && (
                <ConfirmCard question={msg.pendingQuestion} onConfirm={onConfirmQuestion} />
              )}

              {!isUser && msg.artifacts && msg.artifacts.length > 0 && (
                <div className="flex flex-col gap-2 w-full">
                  {msg.artifacts.map((a) => (
                    <ArtifactCard key={a.id} artifact={a} />
                  ))}
                </div>
              )}

                {showMeta && !isUser && msg.steps && msg.steps.length > 0 && (
                  <AgentSteps steps={msg.steps} />
                )}

              <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--td-text-color-placeholder)' }}>
                <span>{formatTime(msg.createdAt)}</span>
                {showMeta && msg.intent && !isUser && (
                  <IntentBadge intent={msg.intent} label={msg.intentLabel} />
                )}
                {msg.content && !msg.isStreaming && <CopyButton text={msg.content} />}
              </div>
            </div>
          </div>
        );
      })}

      {loading && !messages.some((m) => m.isStreaming) && (
          <div className="text-xs pl-11" style={{ color: 'var(--td-text-color-placeholder)' }}>
            栖光正在思考…
          </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
