import type { Request, Response, NextFunction } from 'express';

/** 管理令牌：设置后 /api/admin/* 受保护，未设置则保持开放。路由层判「是否需要令牌」时也要读它。 */
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/**
 * 管理后台鉴权中间件（可选）。
 * 设置 ADMIN_TOKEN 后，所有 /api/admin/* 受保护；未设置则放行（保持现状开放）。
 * token 支持三种来源：query(?token=) / Cookie(admin_token) / Authorization: Bearer 头。
 * 注意：/api/admin/auth-required 永远放行，前端据此判断是否需弹出令牌输入框。
 */
export function createAdminAuth(token: string) {
  return function adminAuth(req: Request, res: Response, next: NextFunction): void {
    if (!token) return next();
    if (req.path === '/api/admin/auth-required') return next();

    const q = req.query.token;
    const auth = req.headers['authorization'];
    const cookie = req.headers.cookie;
    let provided: string | null = null;
    if (typeof q === 'string' && q) provided = q;
    else if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) provided = auth.slice(7).trim();
    else if (cookie && cookie.includes('admin_token=')) {
      provided = decodeURIComponent(cookie.split('admin_token=')[1].split(';')[0]);
    }

    if (provided && provided === token) return next();
    res.status(401).json({ error: '需要管理员令牌', code: 'ADMIN_AUTH_REQUIRED' });
  };
}
