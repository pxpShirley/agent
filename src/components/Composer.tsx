import { useRef, useState, KeyboardEvent, useEffect } from 'react';

interface Props {
  loading: boolean;
  disabled?: boolean;
  placeholder?: string;
  suggestions?: string[];
  onSend: (text: string) => void;
  onStop: () => void;
}

const MAX = 2000;

export function Composer({ loading, disabled, placeholder, suggestions, onSend, onStop }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // 自适应高度
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  useEffect(() => {
    autoResize(ref.current);
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || loading || disabled) return;
    onSend(text);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const fill = (s: string) => {
    if (loading || disabled) return;
    setValue(s);
    requestAnimationFrame(() => {
      autoResize(ref.current);
      ref.current?.focus();
    });
  };

  const showChips = suggestions && suggestions.length > 0 && !value && !loading && !disabled;
  const count = value.length;

  return (
    <div className="composer-wrap">
      {showChips && (
        <div className="composer-chips">
          {suggestions!.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => fill(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div
        className={`composer-box${loading ? ' is-busy' : ''}${disabled ? ' is-disabled' : ''}`}
      >
        <span className="composer-accent" aria-hidden />
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          maxLength={MAX}
          placeholder={
            placeholder || '吩咐栖光做点什么：记件事 / 设提醒 / 理日程 / 规划行程 / 陪我聊聊 / 帮我省钱…'
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="composer-input"
        />
        <div className="composer-bar">
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          <div className="composer-right">
            {count > 0 && <span className="composer-count">{count}/{MAX}</span>}
            {loading ? (
              <button className="composer-send is-stop" onClick={onStop} type="button" title="停止生成" aria-label="停止">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" />
                </svg>
              </button>
            ) : (
              <button
                className="composer-send"
                onClick={submit}
                disabled={!value.trim() || disabled}
                type="button"
                title="发送"
                aria-label="发送"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
