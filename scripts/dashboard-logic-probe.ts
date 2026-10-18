/**
 * 回归探针：灵境仪表盘的领域纯函数
 *
 * 背景（2026-10-06 架构审计 B5）：DashboardPanel 从 619 行拆成三个域面板，
 * 「重复记忆检测」与「目标进度」这两段带判定逻辑的代码被抽到
 * src/components/dashboard/logic.ts，必须锁住行为，避免拆分过程中改坏。
 *
 * 运行：npx tsx scripts/dashboard-logic-probe.ts
 */
import { detectConflictGroups, filterMemories, goalProgress } from '../src/components/dashboard/logic.js';
import { isExpired, isOverdue, fmtDueLabel, toDateInput } from '../src/components/dashboard/shared.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

type Mem = { id: string; kind: string; key: string; value: string; expire_at: string | null };
const mem = (id: string, key: string, kind = 'other', value = 'v', expire_at: string | null = null): Mem =>
  ({ id, kind, key, value, expire_at });

console.log('\n[1] detectConflictGroups —— 重复记忆检测');
{
  const g = (ms: Mem[]) => detectConflictGroups(ms as never);

  ok('空列表不产生分组', g([]).size === 0, `size=${g([]).size}`);

  // 「喜欢咖啡」与「喜欢咖啡口味」归一化后互为前缀 → 同组
  const dup = g([mem('a', '喜欢咖啡'), mem('b', '喜欢咖啡口味')]);
  ok('前缀互为包含 → 判为重复', dup.get('a')?.length === 2 && dup.get('b')?.length === 2,
    `a=${dup.get('a')} b=${dup.get('b')}`);
  ok('分组含自身 id', !!dup.get('a')?.includes('a') && !!dup.get('b')?.includes('b'));

  // 标点/大小写差异不影响判定
  const punct = g([mem('a', '喜欢，咖啡'), mem('b', '喜欢咖啡!')]);
  ok('标点与大小写归一化后仍判为重复', punct.get('a')?.length === 2, `a=${punct.get('a')}`);

  // 短 key 不参与（<4 字符）
  const short = g([mem('a', '猫'), mem('b', '猫粮')]);
  ok('短 key（<4 字）不参与检测', short.size === 0, `size=${short.size}`);

  // 完全不同的主题不误报
  const diff = g([mem('a', '喜欢喝咖啡'), mem('b', '下周去成都')]);
  ok('不同主题不误报重复', diff.size === 0, `size=${diff.size}`);

  // 三条同主题 → 三人一组
  const three = g([mem('a', '通勤路线'), mem('b', '通勤路线偏好'), mem('c', '通勤路线')]);
  ok('三条同主题归入同一组', three.get('a')?.length === 3 && three.get('c')?.length === 3,
    `a=${three.get('a')}`);

  // 单条不产生分组（>1 才算冲突）
  ok('单条记忆不算冲突', g([mem('a', '喜欢咖啡')]).size === 0);
}

console.log('\n[2] filterMemories —— 类目 + 关键词');
{
  const ms = [mem('a', '咖啡', 'food', '喜欢手冲'), mem('b', '通勤', 'travel', '骑车上班')];
  const f = (kind: string, q: string) => filterMemories(ms as never, kind, q).map((m) => m.id).join(',');
  ok('全部类目 + 空关键词 → 全量', f('all', '') === 'a,b', f('all', ''));
  ok('类目过滤生效', f('food', '') === 'a', f('food', ''));
  ok('关键词命中 value', f('all', '骑车') === 'b', f('all', '骑车'));
  ok('关键词命中 key', f('all', '咖啡') === 'a', f('all', '咖啡'));
  ok('关键词大小写不敏感', f('all', 'CAFE') === '' && f('all', '咖啡') === 'a');
  ok('类目 + 关键词同时不满足 → 空', f('food', '骑车') === '', f('food', '骑车'));
}

console.log('\n[3] goalProgress —— 目标进度（只认 due_ts）');
{
  const rem = (o: Partial<{ done: number; due_ts: number | null; created_at: string }>) => ({
    id: 'x', owner: 'guest', due_at: null, body: 'b',
    done: 0, created_at: '2026-10-01T00:00:00.000Z', due_ts: null, ...o,
  });
  const p = (o: Parameters<typeof rem>[0], now: number) => goalProgress(rem(o) as never, now);

  const t0 = new Date('2026-10-01T00:00:00.000Z').getTime();
  const t1 = new Date('2026-10-05T00:00:00.000Z').getTime();

  ok('已完成 → 100', p({ done: 1, due_ts: t1 }, t0) === 100, `${p({ done: 1, due_ts: t1 }, t0)}`);
  ok('无结构化到期 → 25（不猜）', p({ due_ts: null }, t1) === 25, `${p({ due_ts: null }, t1)}`);
  ok('到期等于创建 → 25（除零保护）', p({ due_ts: t0 }, t0) === 25, `${p({ due_ts: t0 }, t0)}`);
  ok('到期早于创建 → 25', p({ due_ts: t0 - 1000 }, t0) === 25);
  ok('时间过半 → 50', p({ due_ts: new Date('2026-10-09T00:00:00Z').getTime() }, t1) === 50,
    `${p({ due_ts: new Date('2026-10-09T00:00:00Z').getTime() }, t1)}`);
  ok('超前完成 → 上限 92', p({ due_ts: t1 }, t1 + 86400000 * 10) === 92);
  ok('刚创建 → 下限 8', p({ due_ts: t1 }, t0) === 8, `${p({ due_ts: t1 }, t0)}`);
  ok('进度单调不回退', goalProgress(rem({ due_ts: t1 }) as never, t0) <= goalProgress(rem({ due_ts: t1 }) as never, t1));
}

console.log('\n[4] 过期 / 逾期判定（A1 修复的行为锁）');
{
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  ok('expire_at 已过 → 过期', isExpired({ id: 'a', owner: 'g', kind: 'other', key: 'k', value: 'v', updated_at: '', expire_at: past } as never));
  ok('expire_at 未到 → 不过期', !isExpired({ id: 'a', owner: 'g', kind: 'other', key: 'k', value: 'v', updated_at: '', expire_at: future } as never));
  ok('expire_at 为空 → 长期记忆，不过期', !isExpired({ id: 'a', owner: 'g', kind: 'other', key: 'k', value: 'v', updated_at: '', expire_at: null } as never));

  const overdue = { id: 'a', owner: 'g', due_at: '10月7日', due_ts: Date.now() - 1000, body: 'b', done: 0, created_at: '' };
  ok('due_ts 已过且未完成 → 逾期', isOverdue(overdue as never));
  ok('已完成不算逾期', !isOverdue({ ...overdue, done: 1 } as never));
  ok('due_ts 为 null → 绝不判逾期（不解析原文）',
    !isOverdue({ ...overdue, due_ts: null, due_at: '最后一天 22:30' } as never));
}

console.log('\n[5] 到期展示与日期回填');
{
  const ts = new Date(2026, 9, 7, 22, 30).getTime();
  ok('fmtDueLabel 用 due_ts 出格式化文本', fmtDueLabel({ due_ts: ts, due_at: '10月7日 晚上 22:30' }) === '2026-10-07 22:30',
    fmtDueLabel({ due_ts: ts, due_at: 'x' }));
  ok('due_ts 为 null 时原样显示原文', fmtDueLabel({ due_ts: null, due_at: '最后一天' }) === '最后一天');
  ok('toDateInput(null) → 空串', toDateInput(null) === '');
  ok('toDateInput 出 YYYY-MM-DD', toDateInput(ts) === '2026-10-07', toDateInput(ts));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);
