import { isIP } from 'net';

/**
 * The visitor's IP behind Cloudflare -> nginx -> GatewayAPI: CF-Connecting-IP (set by Cloudflare) first, then the
 * first X-Forwarded-For hop, then the socket address. Same order as GatewayAPI AuditFilter, CouponAPI and
 * WatermarkAPI. A request that skips Cloudflare can forge these headers, so the value identifies, it does not
 * authenticate.
 */
export function clientIp(req: any): string {
  const header = (name: string): string => {
    const v = req?.headers?.[name];
    return (Array.isArray(v) ? v[0] : v || '').toString().trim();
  };
  const clean = (v: string): string => {
    let s = v.trim();
    if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));          // [v6]:port
    else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':')); // v4:port
    if (s.startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
    return isIP(s) ? s : '';
  };
  const cf = clean(header('cf-connecting-ip'));
  if (cf) return cf;
  const xff = clean(header('x-forwarded-for').split(',')[0] || '');
  if (xff) return xff;
  return clean(String(req?.socket?.remoteAddress || req?.ip || '')) || 'unknown';
}

export function userAgent(req: any): string {
  const v = req?.headers?.['user-agent'];
  return (Array.isArray(v) ? v[0] : v || '').toString().slice(0, 300);
}
