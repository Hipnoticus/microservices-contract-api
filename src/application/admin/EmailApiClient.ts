import { HttpException, HttpStatus } from '@nestjs/common';

export interface OutgoingEmail {
  to: string;
  toName: string;
  subject: string;
  content: string;
  from?: string;
  fromName?: string;
}

/** POST {EmailAPI}/send with the service X-Internal-Token, as SessionEmailService does. Errors become 502. */
export async function sendEmail(baseUrl: string, msg: OutgoingEmail): Promise<void> {
  const token = process.env.EMAIL_API_TOKEN;
  const from = msg.from || 'contato@hipnoterapia.org';
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { 'X-Internal-Token': token } : {}) },
      body: JSON.stringify({
        from, fromName: msg.fromName || 'Hipnoticus', to: msg.to, toName: msg.toName,
        replyTo: 'contato@hipnoterapia.org', subject: msg.subject, content: msg.content,
      }),
    });
  } catch (e) {
    throw new HttpException({ error: `EmailAPI indisponível: ${(e as Error).message}` }, HttpStatus.BAD_GATEWAY);
  }
  if (!res.ok) throw new HttpException({ error: `EmailAPI respondeu ${res.status}.` }, HttpStatus.BAD_GATEWAY);
}

/** Minimal XHTML shell; EmailAPI adds the shared Hipnoticus layout around it. */
export function htmlShell(body: string): string {
  return '<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><title></title></head>'
    + `<body>${body}</body></html>`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function brl(v: unknown): string {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
