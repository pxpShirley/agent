import { useState, useEffect, useCallback } from 'react';
import { useServiceChat } from '../hooks/useServiceChat';
import { XinglanShell } from '../components/XinglanShell';
import type { ChatMessage, PendingQuestion } from '../types';

interface Props {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  accent: 'nebula' | 'warm';
  onToggleAccent: () => void;
  lite: boolean;
  onToggleLite: () => void;
}

const DEMO_RESOLUTION: Record<string, string> = {
  approve: '已执行：两个提醒都设好了 ✅',
  escalate: '已转交人工协助，稍后会有专人跟进。',
  defer: '好的，先记着，稍后再提醒你。',
  cancel: '已取消，不发送。',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function CustomerPage({ theme, onToggleTheme, accent, onToggleAccent, lite, onToggleLite }: Props) {
  const chat = useServiceChat();

  // —— 演示 / 引导模式：首次进入自动播放一段脚本化主动对话，走真实渲染组件 ——
  const [demo, setDemo] = useState(false);
  const [demoMessages, setDemoMessages] = useState<ChatMessage[]>([]);
  const [demoLoading, setDemoLoading] = useState(false);

  const exitDemo = useCallback(() => {
    setDemo(false);
    setDemoMessages([]);
    setDemoLoading(false);
    window.localStorage.setItem('seenDemo', '1');
  }, []);

  const startDemo = useCallback(async () => {
    setDemo(true);
    setDemoMessages([]);
    setDemoLoading(false);
    await sleep(300);
    // 1) 用户诉求
    setDemoMessages([
      {
        id: 'd-u',
        role: 'user',
        content: '帮我规划这周末的杭州短途游，顺便帮我设置一下提醒',
        createdAt: new Date().toISOString(),
      },
    ]);
    await sleep(760);
    // 2) 助手开始：先建空消息(isStreaming)，再像真实 SSE 一样逐字吐字 + 逐步补步骤
    const aId = 'd-a';
    const REPLY = '收到～我先拆解任务，再检索天气与景点资料，最后让复核智能体把关。';
    setDemoMessages((prev) => [
      ...prev,
      { id: aId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true, steps: [] },
    ]);
    setDemoLoading(true);

    // 流式吐字（让“星澜正在说”真实可见：低语条 / 回读面板 / 精灵开口）
    let buf = '';
    for (let i = 0; i < REPLY.length; i += 2) {
      buf = REPLY.slice(0, i + 2);
      setDemoMessages((prev) => prev.map((m) => (m.id === aId ? { ...m, content: buf } : m)));
      await sleep(42);
    }

    const plan: { role: string; name: string }[] = [
      { role: 'planner', name: 'plan' },
      { role: 'researcher', name: 'web_lookup' },
      { role: 'executor', name: 'save_memory' },
      { role: 'critic', name: 'review' },
    ];
    for (const s of plan) {
      setDemoMessages((prev) =>
        prev.map((m) =>
          m.id === aId
            ? { ...m, steps: [...(m.steps || []), { id: 'd-' + s.role, name: s.name, status: 'running' as const, role: s.role }] }
            : m,
        ),
      );
      await sleep(820);
      setDemoMessages((prev) =>
        prev.map((m) => {
          if (m.id !== aId) return m;
          const steps = (m.steps || []).map((x) => (x.role === s.role ? { ...x, status: 'done' as const } : x));
          return { ...m, steps };
        }),
      );
      await sleep(340);
    }
    setDemoMessages((prev) => prev.map((m) => (m.id === aId ? { ...m, content: REPLY, isStreaming: false } : m)));
    setDemoLoading(false);
    await sleep(520);
    // 3) 产物卡（行程草案）
    setDemoMessages((prev) =>
      prev.map((m) =>
        m.id === aId
          ? {
              ...m,
              artifacts: [
                {
                  id: 'd-art',
                  owner: 'guest',
                  session_id: null,
                  type: 'itinerary' as const,
                  title: '杭州周末游 · 草案',
                  content: 'Day1 大奇山 → 瑶琳仙境\nDay2 茅家埠 → 龙井村\n餐厅：茶人村 · 桂语山房',
                  version: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            }
          : m,
      ),
    );
    await sleep(900);
    // 4) 人的环：确认卡（同样做流式，让“正在说”延续到收束前）
    const cId = 'd-c';
    const CQ = '要我顺手把「周五带伞」和「周六 7:30 出发」两个提醒都设好吗？';
    setDemoMessages((prev) => [...prev, { id: cId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true }]);
    let buf2 = '';
    for (let i = 0; i < CQ.length; i += 2) {
      buf2 = CQ.slice(0, i + 2);
      setDemoMessages((prev) => prev.map((m) => (m.id === cId ? { ...m, content: buf2 } : m)));
      await sleep(42);
    }
    setDemoMessages((prev) =>
      prev.map((m) =>
        m.id === cId
          ? {
              ...m,
              content: CQ,
              isStreaming: false,
              pendingQuestion: {
                id: 'd-pq',
                sessionId: '',
                owner: 'guest',
                question: '是否设置这两个提醒？',
                options: ['确认这个分配', '看方案细节', '稍后提醒我', '这次先忽略'],
                status: 'pending',
                answer: null,
                createdAt: new Date().toISOString(),
              },
            }
          : m,
      ),
    );
  }, []);

  const DEMO_STATUS: Record<string, PendingQuestion['status']> = {
    approve: 'confirmed',
    escalate: 'escalated',
    defer: 'deferred',
    cancel: 'cancelled',
  };

  const handleDemoConfirm = useCallback(
    async (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel') => {
      setDemoMessages((prev) =>
        prev.map((m) =>
          m.pendingQuestion && m.pendingQuestion.id === id
            ? { ...m, pendingQuestion: { ...m.pendingQuestion, status: DEMO_STATUS[decision], answer: decision } }
            : m,
        ),
      );
      setDemoMessages((prev) => [
        ...prev,
        {
          id: 'd-res-' + id,
          role: 'assistant',
          content: DEMO_RESOLUTION[decision] || '已处理。',
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    [],
  );

  // 首次访问自动引导
  useEffect(() => {
    if (!window.localStorage.getItem('seenDemo')) startDemo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 消息源：演示模式用脚本消息，否则用真实对话 ——
  const srcMessages = demo ? demoMessages : chat.messages;
  const srcLoading = demo ? demoLoading : chat.loading;
  const pendingMsg = srcMessages.find((m) => m.pendingQuestion && m.pendingQuestion.status === 'pending');
  const pendingQ = pendingMsg?.pendingQuestion ?? null;

  const handleConfirm = useCallback(
    (id: string, decision: 'approve' | 'escalate' | 'defer' | 'cancel') => {
      (demo ? handleDemoConfirm : chat.confirmQuestion)(id, decision);
    },
    [demo, handleDemoConfirm, chat.confirmQuestion],
  );

  const doSend = (t: string) => {
    const v = t.trim();
    if (!v) return;
    if (demo) exitDemo(); // 用户主动说话即退出演示、进入真实对话
    chat.send(v);
  };

  // 离线温柔态：仅在非演示、且确认后端不可达时展示
  const offline = !demo && chat.connected === false;

  return (
    <div className={`app-shell${demo ? ' app-col' : ''}`} style={{ backgroundColor: 'transparent', position: 'relative' }}>
      {/* 演示横幅：内联于页面顶部（非浮层），仅演示模式出现 */}
      {demo && (
        <div className="shell-demo" onClick={exitDemo} title="点击退出演示">
          <span>
            <b>演示模式</b> · 栖光正在展示它的工作方式（点此退出）
          </span>
          <button
            className="demo-x"
            onClick={(e) => {
              e.stopPropagation();
              exitDemo();
            }}
          >
            退出
          </button>
        </div>
      )}

      <XinglanShell
        accent={accent}
        lite={lite}
        theme={theme}
        onToggleTheme={onToggleTheme}
        messages={srcMessages}
        context={chat.context}
        loading={srcLoading}
        pendingQ={pendingQ}
        onSend={doSend}
        onStop={chat.stop}
        onConfirm={handleConfirm}
        onToggleAccent={onToggleAccent}
        onToggleLite={onToggleLite}
        connected={chat.connected}
        offline={offline}
        onReconnect={chat.reconnect}
        notice={chat.notice}
        onDismissNotice={() => chat.setNotice(null)}
        sessions={chat.sessions}
        onNewChat={chat.startNewChat}
        proactive={!demo ? chat.proactive.find((c) => c.status === 'pending') ?? null : null}
        onProactiveAccept={(id) => chat.markProactiveSeen(id)}
        onProactiveDismiss={(id) => chat.dismissProactiveCard(id)}
        onProactiveAction={(id, type) => chat.proactiveAction(id, type)}
        onContextChanged={chat.refreshContext}
      />
    </div>
  );
}
