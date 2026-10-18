/**
 * 星澜 · 真实出站执行层（打通「代理真会办事」）
 *
 * 把「人在环确认后的高风险动作 / 新创建的提醒」真正发出去，而不只是本地落库。
 * 设计：凭证门控 + 错误容忍——配了通道就真执行，没配就优雅回退（不影响主流程）。
 *
 * 通道优先级：
 *  1) Webhook（OUTBOUND_WEBHOOK_URL）：通用出站，飞书/企业微信/IFTTT/Zapier/自建都可用。
 *     任意结构化的「事件」POST 出去，由接收方决定怎么落地（发消息/写日历/推送）。
 *  2) 邮件（SMTP_*）：仅当配置了收件人 + SMTP 凭证时启用，作为兜底通道。
 *
 * 所有网络调用均设超时与异常捕获；失败只返回错误，绝不抛出到调用方主流程。
 */
import { getOutboundWebhook, getSmtpConfig, isSmtpConfigured } from '../settings.js';

export type OutboundChannel = 'webhook' | 'email' | 'none';

export interface OutboundResult {
  ok: boolean;
  channel: OutboundChannel;
  error?: string;
}

export interface OutboundMeta {
  owner?: string;
  sessionId?: string;
  intent?: string;
  kind?: string;
  /** 邮件收件人（仅邮件通道使用） */
  to?: string;
  subject?: string;
}

/** 把任意结构化事件 POST 到出站 Webhook（最佳努力） */
export async function postWebhook(event: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const url = getOutboundWebhook();
  if (!url) return { ok: false, error: 'OUTBOUND_WEBHOOK_URL 未配置' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'xinglan', ts: Date.now(), ...event }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, error: `webhook 返回 ${resp.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 经 SMTP 发邮件（依赖 nodemailer；未安装或凭证缺失则返回错误，不抛出） */
export async function sendEmail(msg: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return { ok: false, error: 'SMTP 未配置' };
  try {
    // @ts-ignore - nodemailer 为可选依赖，未安装时动态 import 失败，由上层的错误容忍兜住
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 465,
      secure: (cfg.port || 465) === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transporter.sendMail({
      from: cfg.from || cfg.user,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 通用「 relay 」：把一段要对外说的话真正发出去。
 * 优先 Webhook；若未配 Webhook 但配了邮件且给了收件人，走邮件；都未配则回退失败。
 */
export async function relayOutbound(text: string, meta: OutboundMeta = {}): Promise<OutboundResult> {
  const wh = await postWebhook({ event: 'relay', text, ...meta });
  if (wh.ok) return { ok: true, channel: 'webhook' };

  if (meta.to && isSmtpConfigured()) {
    const em = await sendEmail({
      to: meta.to,
      subject: meta.subject || '星澜 · 来自管家的消息',
      body: text,
    });
    return em.ok ? { ok: true, channel: 'email' } : { ok: false, channel: 'email', error: em.error };
  }
  return { ok: false, channel: 'none', error: wh.error || '未配置任何出站通道（Webhook / SMTP）' };
}

/** 提醒创建后同步到外部（最佳努力，失败静默忽略） */
export async function syncReminder(what: string, when: string | null, owner: string): Promise<void> {
  await postWebhook({ event: 'reminder.created', what, when, owner });
}
