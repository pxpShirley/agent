/**
 * 本地音乐接口（M 音乐能力）
 *
 * ⚠️ `/stream/:id` 必须支持 HTTP Range（206 Partial Content）：
 * 不做 Range，浏览器进度条就拖不动、大 flac 也要整首下完才出声。
 */
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import * as db from '../db.js';
import { getMusicDir, isMusicConfigured, scanMusic, resolveTrackPath, mimeOf } from '../music.js';

export function registerMusic(app: Express): void {
  // 状态：目录是否可用、已索引多少首
  app.get('/api/music/status', (_req, res) => {
    res.json({
      dir: getMusicDir(),
      exists: isMusicConfigured(),
      count: db.countTracks(),
    });
  });

  // 重新扫描（幂等；设置页改了目录后点它）
  app.post('/api/music/scan', async (_req, res) => {
    try {
      const r = await scanMusic();
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 列表 / 搜索
  app.get('/api/music/tracks', (req, res) => {
    const q = String(req.query.q || '').slice(0, 100);
    const limit = Number(req.query.limit) || 200;
    res.json({ tracks: db.listTracks(q, limit) });
  });

  // 上报"真的播了"（用于最近播过降权，避免反复推同一首）
  app.post('/api/music/played', (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少 id' });
    db.markPlayed(id);
    res.json({ success: true });
  });

  // 音频流：支持 Range
  app.get('/api/music/stream/:id', (req, res) => {
    const r = resolveTrackPath(req.params.id);
    if (!r.ok) return res.status(r.reason === '曲目不存在' ? 404 : 403).json({ error: r.reason });

    let size = 0;
    try {
      size = fs.statSync(r.full).size;
    } catch {
      return res.status(404).json({ error: '读取文件失败' });
    }
    const type = mimeOf(path.extname(r.full));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        if (!Number.isFinite(start)) start = 0;
        if (!Number.isFinite(end) || end > size - 1) end = size - 1;
        if (start > end || start >= size) {
          res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(r.full, { start, end }).pipe(res);
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', String(size));
    fs.createReadStream(r.full).pipe(res);
  });
}
