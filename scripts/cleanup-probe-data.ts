// 清理探针产生的测试数据（owner 以 probe_user_ 命名空间隔离）
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'chat.db');
const db = new Database(dbPath);

const pat = 'probe_%';
const m = db.prepare("DELETE FROM memories WHERE owner LIKE ?").run(pat);
const r = db.prepare("DELETE FROM reminders WHERE owner LIKE ?").run(pat);
const p = db.prepare("DELETE FROM pending_questions WHERE owner LIKE ?").run(pat);
const s = db.prepare("DELETE FROM sessions WHERE customer_name LIKE ?").run(pat);
console.log(`cleaned: memories=${m.changes} reminders=${r.changes} pending=${p.changes} sessions=${s.changes}`);
db.close();
