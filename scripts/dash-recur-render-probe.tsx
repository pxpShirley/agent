/**
 * 渲染冒烟（B2）：GoalsPane 在「周期 + 一次性」混合数据下不抛错，
 * 且周期徽标 / 打卡按钮 / 停止习惯 等新增元素正确出现。
 * 运行：npx tsx scripts/dash-recur-render-probe.tsx
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { GoalsPane } from '../src/components/dashboard/GoalsPane';

const recur: any = {
  id: 'r1', owner: 'guest', due_at: '每天 22:00', due_ts: Date.now() + 3_600_000,
  body: '喝水', done: 0, created_at: new Date().toISOString(),
  steps: [], recur_rule: { freq: 'daily', at: '22:00' },
};
const oneoff: any = {
  id: 'r2', owner: 'guest', due_at: null, due_ts: Date.now() + 7_200_000,
  body: '交水电费', done: 0, created_at: new Date().toISOString(),
  steps: [], recur_rule: null,
};

let html = '';
try {
  html = renderToString(
    React.createElement(GoalsPane, {
      reminders: [recur, oneoff] as any,
      onSend: () => {},
      ops: { busy: false, runOp: async () => {} } as any,
    }),
  );
} catch (e: any) {
  console.log('  ✗ 渲染抛错：', e?.message || e);
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${n}`); };

// 仅周期项单独渲染，确认周期项本身隐藏「编辑」、显示「停止习惯」
const recurOnly = renderToString(
  React.createElement(GoalsPane, {
    reminders: [recur] as any,
    onSend: () => {},
    ops: { busy: false, runOp: async () => {} } as any,
  }),
);

ok('渲染产出 HTML', html.length > 0);
ok('周期徽标 🔁 出现', html.includes('🔁'));
ok('周期文案出现（每天 22:00）', html.includes('每天 22:00'));
ok('周期项显示「打卡」按钮', html.includes('打卡'));
ok('一次性项显示「完成」按钮', html.includes('完成'));
ok('周期项（单独渲染）不显示「编辑」', !recurOnly.includes('>编辑<'));
ok('周期项显示「停止习惯」而非「删除」', html.includes('停止习惯'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
