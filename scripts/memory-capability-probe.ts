/**
 * 记忆/待办能力回归探针（不依赖大模型 Key，纯逻辑校验）
 * 验证 Priority 3 的两处改动：
 *  1) activeToolDefs 对「全新 owner（库为空）」也暴露 recall_memory / get_schedule（不再鸡生蛋裁剪）
 *  2) buildSystemPrompt 包含「主动记住用户」硬规则
 */
import { activeToolDefs } from '../server/llm/bailian.ts';
import { buildSystemPrompt } from '../server/agent.ts';

const FRESH = '__probe_fresh_owner_' + Date.now();

const defs = activeToolDefs(FRESH);
const names = defs.map((d) => d.name);
const hasRecall = names.includes('recall_memory');
const hasSchedule = names.includes('get_schedule');
const hasSave = names.includes('save_memory');

console.log('[tool-defs] 全新 owner 可见工具：', names.join(', '));
console.log('[tool-defs] recall_memory 可见?', hasRecall, '| get_schedule 可见?', hasSchedule, '| save_memory 可见?', hasSave);

const prompt = buildSystemPrompt('（探针注入占位）');
const rule11 = prompt.includes('主动记住用户');
const saveDuty = /先调用 save_memory/.test(prompt);
console.log('[prompt] 含「主动记住用户」规则?', rule11, '| 含「先调用 save_memory」?', saveDuty);

const ok = hasRecall && hasSchedule && hasSave && rule11 && saveDuty;
console.log(ok ? '\n✅ Priority 3 逻辑改动校验通过' : '\n❌ 校验失败');
process.exit(ok ? 0 : 1);
