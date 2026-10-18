// 清理 artifact-version-probe.ts 在产物历史里留下的测试版本行（保留原始版本）
import Database from 'better-sqlite3';

const db = new Database(new URL('../data/chat.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEST = ['第一版改动内容', '第二版改动内容'];

const rows = db
  .prepare('SELECT * FROM artifact_versions WHERE content IN (?, ?)')
  .all(...TEST) as Array<{ id: string; artifact_id: string; version: number }>;
for (const r of rows) db.prepare('DELETE FROM artifact_versions WHERE id = ?').run(r.id);
console.log(`删除测试版本行 ${rows.length} 条（${rows.map((r) => 'v' + r.version).join('、')}）`);

const left = db.prepare('SELECT artifact_id, COUNT(*) c FROM artifact_versions GROUP BY artifact_id').all() as Array<{ artifact_id: string; c: number }>;
console.log('剩余历史行数：', JSON.stringify(left));
console.log('产物现状：', JSON.stringify(db.prepare('SELECT id, version, substr(content,1,24) c FROM artifacts').all()));
