/**
 * 本地音乐：目录配置 + 扫描索引 + 路径安全校验（M 音乐能力）
 *
 * 三条硬纪律：
 * 1. **文件永远留在原处** —— 只扫路径与元数据，绝不复制、绝不入库、绝不上传。
 * 2. **路径必须校验根目录** —— 任何对外暴露的文件流都要先 `startsWith(root)`，防目录穿越。
 * 3. **不引第三方元数据依赖** —— 时长交给浏览器端 `<audio>` 读（零成本），
 *    服务端只解析文件名里的「歌手 - 歌名」，解析不出来就以文件名兜底。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as db from './db.js';

/** 支持的音频扩展名（全是浏览器原生可播的，避免转码依赖） */
export const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'];

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

export function mimeOf(ext: string): string {
  return MIME[ext.toLowerCase()] || 'application/octet-stream';
}

/** 音乐目录：环境变量 MUSIC_DIR 优先，回退到系统「音乐」目录 */
export function getMusicDir(): string {
  const env = (process.env.MUSIC_DIR || '').trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), 'Music');
}

export function isMusicConfigured(): boolean {
  try {
    return fs.existsSync(getMusicDir());
  } catch {
    return false;
  }
}

/** 从文件名解析「歌手 - 歌名」；解析不出来就用文件名兜底 */
function parseName(filename: string): { title: string; artist: string | null } {
  const base = filename.replace(/\.[^.]+$/, '').trim();
  // 去掉开头的音轨序号：01 / 01. / 01 -
  const noTrack = base.replace(/^\d{1,3}[\s.\-_]+/, '').trim() || base;
  // 支持半角/全角/长横线
  const m = noTrack.split(/\s+[—–\-]\s+/);
  if (m.length >= 2) {
    const artist = m[0].trim();
    const title = m.slice(1).join(' - ').trim();
    if (artist && title) return { title, artist };
  }
  return { title: noTrack || base, artist: null };
}

export interface ScanResult {
  ok: boolean;
  dir: string;
  exists: boolean;
  found: number;
  added: number;
  updated: number;
  removed: number;
  total: number;
  error?: string;
}

const MAX_FILES = 5000;
const MAX_DEPTH = 6;

/** 扫描音乐目录并写入索引（幂等；已失效的路径会被清理） */
export async function scanMusic(): Promise<ScanResult> {
  const root = getMusicDir();
  const empty = (exists: boolean, error?: string): ScanResult => ({
    ok: false, dir: root, exists, found: 0, added: 0, updated: 0, removed: 0, total: db.countTracks(), error,
  });
  if (!root) return empty(false, '未配置音乐目录');
  if (!fs.existsSync(root)) return empty(false, `目录不存在：${root}`);

  const found: Array<{ full: string; mtime: number; size: number }> = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限目录直接跳过
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
        try {
          const st = await fs.promises.stat(full);
          found.push({ full, mtime: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* 跳过读不到的文件 */
        }
      }
    }
  };
  await walk(root, 0);

  let added = 0;
  let updated = 0;
  for (const f of found) {
    const { title, artist } = parseName(path.basename(f.full));
    const before = db.allTrackPaths().find((p) => p.path === f.full);
    db.upsertTrack({ path: f.full, title, artist, mtime: f.mtime, size: f.size });
    if (!before) added++;
    else if (before.mtime !== f.mtime) updated++;
  }

  // 清理：索引里有、磁盘上已不在的路径
  const alive = new Set(found.map((f) => f.full));
  let removed = 0;
  for (const p of db.allTrackPaths()) {
    if (!alive.has(p.path)) {
      db.deleteTrack(p.id);
      removed++;
    }
  }

  return { ok: true, dir: root, exists: true, found: found.length, added, updated, removed, total: db.countTracks() };
}

// ----------------------------------------------------------------
// 服务端 → 前端的一次性动作通道
// 工具只能返回文本给模型，真正"出声"在浏览器里。这里存一条待发送的播放指令，
// 由 /api/chat 的 SSE 在 tool_result 时刻取出并下发（带时效，过期作废）。
// ----------------------------------------------------------------
export interface MusicAction {
  ids?: string[];
  action?: 'play' | 'pause' | 'resume' | 'next' | 'prev' | 'volume';
  value?: number;
  reason?: string;
}

let pending: (MusicAction & { at: number }) | null = null;

export function setMusicAction(a: MusicAction): void {
  pending = { ...a, at: Date.now() };
}

/** 取出并清空；超过 15s 视为过期（避免跨轮次误触发） */
export function takeMusicAction(): MusicAction | null {
  const p = pending;
  pending = null;
  if (!p) return null;
  if (Date.now() - p.at > 15000) return null;
  return { ids: p.ids, action: p.action, value: p.value, reason: p.reason };
}

/** 把 track id 解析为可安全读取的绝对路径。
 * ⚠️ 安全底线：双重校验 —— ① 必须是索引里存在的 id；② resolve 后必须仍在音乐根目录内。
 * 任一条不满足就拒绝，避免 `/api/music/stream/xxx` 变成读整块磁盘的口子。
 */
export function resolveTrackPath(id: string): { ok: true; full: string; track: db.TrackRecord } | { ok: false; reason: string } {
  const track = db.getTrack(id);
  if (!track) return { ok: false, reason: '曲目不存在' };
  const root = path.resolve(getMusicDir());
  const full = path.resolve(track.path);
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, reason: '路径越出音乐目录' };
  if (!fs.existsSync(full)) return { ok: false, reason: '文件已不在磁盘上' };
  return { ok: true, full, track };
}
