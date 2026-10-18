import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import type {
  ChatMessage,
  IntentCode,
  SessionSummary,
  SessionStatus,
  AgentContext,
  AgentStep,
  ProactiveCard,
  PendingQuestion,
  Artifact,
  NowData,
} from '../types';
import { INTENT_META } from '../types';
import {
  uid,
  parseSseChunk,
  applyStepResult,
  settleSteps,
  decisionToStatus,
  intentLabelOf,
  artifactFromEvent,
  pendingFromEvent,
  patchMessage,
} from '../utils/chatStream';
import { runLocalMock } from '../utils/localFallback';

// 引擎看门狗时长：真实引擎在该时长内未吐出任何内容（text/tool/tool_result/artifact/ask_user/done）
// 即掐断死流并切本地兜底。从 6s 放宽到 30s，给"慢但正常"的多 Agent / 联网查询留足余量，
// 避免把"慢慢想"误判成"引擎不可用"而频繁弹兜底提示。后端另有 15s 失败快退，二者配合：
// 真·卡死由后端先兜底（提示更柔和），前端看门狗只作最后兜底。须大于后端 CHAT_ENGINE_TIMEOUT_MS(120000)。
const ENGINE_WATCHDOG_MS = 150000;

export function useServiceChat() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>('bot');
  const [intent, setIntent] = useState<{ code: IntentCode; label: string } | null>(null);
  const [context, setContext] = useState<AgentContext | null>(null);
  const [proactive, setProactive] = useState<ProactiveCard[]>([]);
  const [now, setNow] = useState<NowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // 连通性探测：挂载时轻量 ping 一次 /api/now，失败时标记离线（供 UI 优雅降级）
  const reconnect = useCallback(async () => {
    setConnected(null);
    try {
      await api.now('guest');
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  const refreshContext = useCallback(async () => {
    try {
      const ctx = await api.context('guest');
      setContext(ctx);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshProactive = useCallback(async () => {
    try {
      const { cards } = await api.proactive('guest');
      setProactive(cards);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshNow = useCallback(async () => {
    try {
      const data = await api.now('guest');
      setNow(data);
    } catch {
      /* 忽略 */
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await api.listSessions();
      setSessions(sessions);
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    refreshContext();
    refreshProactive();
    refreshNow();
  }, [refreshSessions, refreshContext, refreshProactive, refreshNow]);

  useEffect(() => {
    reconnect();
  }, [reconnect]);

  const openSession = useCallback(async (id: string) => {
    setCurrentId(id);
    try {
      const data = await api.getSession(id);
      setMessages(data.messages);
      setStatus(data.session.status);
      setIntent({ code: data.session.intent, label: intentLabelOf(data.session.intent) });
      refreshContext();
      refreshProactive();
    } catch (e: any) {
      setNotice(e?.message || '加载会话失败');
    }
  }, []);

  const startNewChat = useCallback(() => {
    setCurrentId(null);
    setMessages([]);
    setStatus('bot');
    setIntent(null);
    setNotice(null);
  }, []);

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      if (id === currentId) startNewChat();
      refreshSessions();
    },
    [currentId, refreshSessions, startNewChat]
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || loading) return;

      const tempUserId = uid();
      const tempAssistantId = uid();
      const nowIso = new Date().toISOString();

      setMessages((prev) => [
        ...prev,
        { id: tempUserId, role: 'user', content, createdAt: nowIso },
        { id: tempAssistantId, role: 'assistant', content: '', createdAt: nowIso, isStreaming: true },
      ]);
      setLoading(true);
      setNotice(null);

      const controller = new AbortController();
      abortRef.current = controller;
      // 专用中止器：只掐断网络读取，不影响本地兜底（runLocalMock 用 controller 判断自身中断）
      const fetchAbort = new AbortController();
      fetchAbortRef.current = fetchAbort;
      // 本轮后端是否已发过「回退/异常」类提示；避免 done.fallback 时再用更刺眼的文案覆盖它
      let sawNotice = false;

      // —— 引擎卡死看门狗 ——
      // 引擎长时间不吐字（配额耗尽 / 网络挂死）时不苦等，直接掐断死流切本地兜底。
      let fed = false;
      let fallbackDone = false;
      const markFed = () => {
        if (!fed) {
          fed = true;
          clearTimeout(watchdog);
        }
      };
      const runMock = () =>
        runLocalMock({
          content,
          signal: controller.signal,
          patch: (p) => patchAssistant(p),
          applyContext: (fn) => setContext(fn),
          setOnline: () => setConnected(true),
        });
      const triggerFallback = async () => {
        if (fallbackDone) return;
        fallbackDone = true;
        clearTimeout(watchdog);
        if (!fed) setNotice('引擎暂时不可用（模型调用失败），以上为本地兜底回复');
        await runMock();
      };
      const watchdog = setTimeout(() => {
        if (!fed) {
          fetchAbort.abort();
          void triggerFallback();
        }
      }, ENGINE_WATCHDOG_MS);

      let assistantId = tempAssistantId;
      let sessionId = currentId;
      let buffer = '';
      let steps: AgentStep[] = [];
      let artifacts: Artifact[] = [];

      const patchAssistant = (patch: Partial<ChatMessage>) =>
        setMessages((prev) => patchMessage(prev, assistantId, patch));

      const settle = (markError = false) => {
        steps = settleSteps(steps, markError);
        return steps;
      };

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message: content }),
          signal: fetchAbort.signal,
        });

        // 后端 5xx / 4xx：落到本地兜底
        if (!res.ok) {
          clearTimeout(watchdog);
          await triggerFallback();
          return;
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(decoder.decode(value, { stream: true }), sseBuffer);
          sseBuffer = parsed.buffer;

          for (const data of parsed.events) {
            if (data.type === 'init') {
              sessionId = data.sessionId;
              setCurrentId(data.sessionId);
              setIntent({ code: data.intent, label: data.intentLabel || intentLabelOf(data.intent) });
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === tempUserId
                    ? { ...m, id: data.userMessageId, intent: data.intent }
                    : m.id === tempAssistantId
                    ? { ...m, id: data.assistantMessageId }
                    : m
                )
              );
              assistantId = data.assistantMessageId;
            } else if (data.type === 'text') {
              markFed();
              buffer += data.content;
              patchAssistant({ content: buffer });
            } else if (data.type === 'tool') {
              markFed();
              steps = [...steps, { id: uid(), name: data.name, input: data.input, status: 'running', role: data.role }];
              patchAssistant({ steps: [...steps] });
            } else if (data.type === 'tool_result') {
              markFed();
              steps = applyStepResult(steps, data.name, data.ok);
              patchAssistant({ steps: [...steps] });
            } else if (data.type === 'music') {
              // 音乐：服务端只给出指令（曲 id / 控制动作），真正播放交给浏览器里的播放器
              markFed();
              if (data.ids && data.ids.length) {
                window.dispatchEvent(
                  new CustomEvent('xl-music', { detail: { ids: data.ids, reason: data.reason || '' } }),
                );
              } else if (data.action) {
                window.dispatchEvent(
                  new CustomEvent('xl-music-control', { detail: { action: data.action, value: data.value } }),
                );
              }
            } else if (data.type === 'artifact') {
              markFed();
              artifacts = [...artifacts, artifactFromEvent(data, sessionId)];
              patchAssistant({ artifacts: [...artifacts] });
            } else if (data.type === 'notice') {
              setNotice(data.message);
              sawNotice = true;
            } else if (data.type === 'ask_user') {
              markFed();
              patchAssistant({ pendingQuestion: pendingFromEvent(data, sessionId) });
            } else if (data.type === 'done') {
              markFed();
              patchAssistant({
                isStreaming: false,
                intent: data.intent,
                intentLabel: data.intentLabel || intentLabelOf(data.intent),
                tools: data.tools || [],
                steps: [...settle(data.fallback === true)],
                artifacts: artifacts.length ? [...artifacts] : undefined,
                ...(data.choices?.length ? { choices: data.choices } : {}),
              });
              setIntent({ code: data.intent, label: data.intentLabel || intentLabelOf(data.intent) });
              // 引擎不可用时明确告知，避免把兜底回复当成模型的真实回答；
              // 但后端若已发过更柔和的回退提示，则不重复覆盖，避免刺眼文案频现。
              if (data.fallback === true && !sawNotice) {
                setNotice('引擎暂时不可用（模型调用失败），以上为本地兜底回复');
              }
            }
          }
        }
        // 兜底：流已断但没收到 done 事件（连接被掐断 / 服务端提前关闭）
        patchAssistant({ isStreaming: false, steps: [...settle()] });
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          if (!fed) {
            // 看门狗掐断死流（引擎卡死）：切本地兜底，保证对话有反应
            await triggerFallback();
          } else {
            // 用户主动中止：步骤停在哪算哪，但不能留 running 的转圈
            patchAssistant({ isStreaming: false, steps: [...settle()] });
          }
        } else {
          // 网络异常 / 后端挂：本地兜底让对话有反应
          await triggerFallback();
        }
      } finally {
        clearTimeout(watchdog);
        setLoading(false);
        abortRef.current = null;
        fetchAbortRef.current = null;
        refreshSessions();
        refreshContext();
        refreshProactive();
        refreshNow();
      }
    },
    [currentId, loading, refreshSessions, refreshContext, refreshProactive, refreshNow]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    fetchAbortRef.current?.abort();
    setLoading(false);
  }, []);

  const markProactiveSeen = useCallback(
    async (id: string) => {
      setProactive((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'seen' } : c)));
      try {
        await api.proactiveSeen(id);
      } catch {
        /* 忽略 */
      }
    },
    []
  );

  const dismissProactiveCard = useCallback(
    async (id: string) => {
      setProactive((prev) => prev.filter((c) => c.id !== id));
      try {
        await api.proactiveDismiss(id);
      } catch {
        /* 忽略 */
      }
    },
    []
  );

  /**
   * A4 主动卡内联动作（统一入口）：
   * - 服务端动作（complete/snooze_*）：后端已按 ref_id 操作待办并把卡片 dismissed；
   *   本地立即从浮卡列表移除，刷新后也不会复现。
   * - 客户端动作（ask_agent/open_view）：后端返回 clientOnly，真实行为由 XinglanShell 触发
   *   （dispatch 提问 / 切视图）；本地同样收起浮卡，避免重复浮起。
   * 不论成功与否都先收起卡片，保证响应感；返回结果供调用方决定后续（如提问要不要在卡片消失后再发）。
   */
  const proactiveAction = useCallback(
    async (id: string, type: string): Promise<{ ok: boolean; clientOnly?: boolean; error?: string }> => {
      let result: { ok: boolean; clientOnly?: boolean; error?: string } = { ok: true };
      try {
        result = await api.proactiveAction(id, type);
      } catch {
        /* 忽略：本地收起即可，不阻断交互 */
      }
      setProactive((prev) => prev.filter((c) => c.id !== id));
      return result;
    },
    []
  );

  const confirmQuestion = useCallback(
    async (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel', value?: string) => {
      const status = decisionToStatus(decision);
      // 先本地把卡片置为已解决，提升响应感
      setMessages((prev) =>
        prev.map((m) =>
          m.pendingQuestion && m.pendingQuestion.id === id
            ? { ...m, pendingQuestion: { ...m.pendingQuestion, status, answer: decision } }
            : m
        )
      );
      try {
        const { resolution } = await api.confirmQuestion(id, decision, value);
        setMessages((prev) => [
          ...prev,
          { id: 'res-' + id, role: 'assistant', content: resolution, createdAt: new Date().toISOString() },
        ]);
        refreshSessions();
        refreshContext();
      } catch (e: any) {
        setNotice(e?.message || '操作失败');
      }
    },
    [refreshSessions, refreshContext]
  );

  return {
    sessions,
    currentId,
    messages,
    status,
    intent,
    context,
    proactive,
    now,
    agentBusy: loading,
    loading,
    connected,
    reconnect,
    notice,
    setNotice,
    send,
    stop,
    openSession,
    startNewChat,
    removeSession,
    markProactiveSeen,
    dismissProactiveCard,
    proactiveAction,
    confirmQuestion,
    refreshNow,
    refreshSessions,
    refreshContext,
  };
}
