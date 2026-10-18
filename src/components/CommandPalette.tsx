import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentContext, SessionSummary } from '../types';
import { CAPABILITIES } from '../utils/butler';
import { relativeTime } from '../utils/format';
import { highlightNodes } from '../utils/highlight';

interface Item {
  group: '发起' | '能力' | '记忆' | '历史';
  title: string;
  desc: string;
  prompt: string; // 选中即 dispatch 的开口语
}

const GROUP_ICON: Record<Item['group'], string> = {
  发起: '➤',
  能力: '✦',
  记忆: '🧠',
  历史: '🕘',
};

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (text: string) => void;
  context: AgentContext | null;
  sessions: SessionSummary[];
}

// ⌘K 命令面板：跨「能力 / 记忆 / 历史」统一检索与发起
// 零模态纪律：遮罩点击或 Esc 关闭，选中后统一 dispatch（关浮层 + 切主页 + 发送）
export function CommandPalette({ open, onClose, onPick, context, sessions }: Props) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const caps: Item[] = CAPABILITIES.map((c) => ({ group: '能力', title: c.title, desc: c.desc, prompt: c.prompt }));
    const mems: Item[] = (context?.memories || [])
      .slice(0, 6)
      .map((m) => ({ group: '记忆', title: m.key || m.value, desc: m.value, prompt: `回忆一下我记的关于「${m.key || m.value}」的事` }));
    const hist: Item[] = sessions
      .slice(0, 6)
      .map((s) => ({ group: '历史', title: s.title || '新的对话', desc: `上次更新 ${relativeTime(s.updated_at)}`, prompt: `继续我们关于「${s.title || '上次对话'}」的对话` }));
    return [...caps, ...mems, ...hist];
  }, [context, sessions]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const base = !kw ? items : items.filter((it) => `${it.title}${it.desc}${it.group}`.toLowerCase().includes(kw));
    // 自由发起：输入即开口，不必先命中某一项
    const free: Item[] = kw
      ? [{ group: '发起', title: q.trim(), desc: '把这句话直接交给栖光', prompt: q.trim() }]
      : [];
    return [...free, ...base];
  }, [items, q]);

  // 打开即清空并聚焦；关闭复位选择
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => { setSel(0); }, [q]);

  // 选择项滚入视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`.cmdk-item[data-i="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, filtered]);

  const pick = (it?: Item) => {
    if (!it) return;
    onPick(it.prompt);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  if (!open) return null;

  let lastGroup = '';
  return (
    <div className="nx-cmdk-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nx-cmdk" role="dialog" aria-label="命令面板">
        <div className="cmdk-pin">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="搜索能力、记忆、历史，或描述你想做的事…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            aria-label="命令面板搜索"
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {filtered.map((it, i) => {
            const showGroup = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={`${it.group}-${it.title}-${i}`}>
                {showGroup && <div className="cmdk-group">{GROUP_ICON[it.group]} {it.group}</div>}
                <button
                  type="button"
                  data-i={i}
                  className={`cmdk-item${i === sel ? ' sel' : ''}${it.group === '发起' ? ' free' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(it)}
                >
                  <span className="cmdk-ico">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M5 12l4 4L19 6" />
                    </svg>
                  </span>
                  <span className="cmdk-text">
                    <span className="cmdk-title">{highlightNodes(it.title, q)}</span>
                    <span className="cmdk-desc">{it.desc}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 发起</span>
          <span><kbd>esc</kbd> 关闭</span>
          <span className="cmdk-count">{filtered.length} 项</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
