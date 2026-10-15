/**
 * GoogleCalendarClient — minimal fetch-based Google OAuth 2.0 + Calendar API v3 client.
 *
 * Only what the one-way agenda sync needs. No googleapis dependency.
 * Scope is `calendar.app.created`: the app can create its own secondary calendars and
 * manage events on them, and nothing else in the user's Google Calendar.
 */
import { sha256Hex } from './TokenCrypto';

export const GCAL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created'];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}
/** Refresh token revoked/expired (401 or invalid_grant). The account must be reconnected. */
export class GoogleAuthRevokedError extends GoogleApiError {}
/** 404 / 410. */
export class GoogleNotFoundError extends GoogleApiError {}
/** 409 (e.g. event id already used). */
export class GoogleConflictError extends GoogleApiError {}

export interface GoogleEventDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GoogleEventPayload {
  summary: string;
  description: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  status: 'confirmed';
  transparency: 'opaque';
  reminders: { useDefault: false; overrides: [] };
  id?: string;
}

export interface ExchangeResult {
  refreshToken: string | null;
  email: string;
  emailVerified: boolean;
}

/** Interface used by the sync engine and controller so tests can supply a fake. */
export interface IGoogleCalendarClient {
  buildAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<ExchangeResult>;
  getAccessToken(refreshToken: string): Promise<string>;
  revoke(token: string): Promise<void>;
  insertCalendar(accessToken: string, summary: string, timeZone: string): Promise<string>;
  getCalendar(accessToken: string, calendarId: string): Promise<void>;
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  insertEvent(accessToken: string, calendarId: string, event: GoogleEventPayload): Promise<string>;
  updateEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEventPayload): Promise<void>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function decodeJwtPayload(jwt: string): any {
  const part = (jwt || '').split('.')[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

export class GoogleCalendarClient implements IGoogleCalendarClient {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly config: GoogleOAuthConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: GCAL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent select_account',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<ExchangeResult> {
    const body = await this.tokenRequest({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });
    // The id_token comes straight from Google's token endpoint over TLS, so its claims
    // can be read without verifying the signature (Google OpenID Connect guidance).
    const claims = decodeJwtPayload(body.id_token);
    if (body.access_token && body.refresh_token) {
      this.cacheAccessToken(body.refresh_token, body.access_token, body.expires_in);
    }
    return {
      refreshToken: body.refresh_token || null,
      email: String(claims.email || '').toLowerCase(),
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    };
  }

  async getAccessToken(refreshToken: string): Promise<string> {
    const key = sha256Hex(refreshToken);
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const body = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    this.cacheAccessToken(refreshToken, body.access_token, body.expires_in);
    return body.access_token;
  }

  async revoke(token: string): Promise<void> {
    this.tokenCache.delete(sha256Hex(token));
    const res = await this.fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 = already invalid; both outcomes leave the grant revoked.
    if (!res.ok && res.status !== 400) throw new GoogleApiError(`Google revoke failed (HTTP ${res.status})`, res.status);
  }

  async insertCalendar(accessToken: string, summary: string, timeZone: string): Promise<string> {
    const body = await this.api(accessToken, 'POST', '/calendars', { summary, timeZone });
    return body.id;
  }

  async getCalendar(accessToken: string, calendarId: string): Promise<void> {
    await this.api(accessToken, 'GET', `/calendars/${encodeURIComponent(calendarId)}`);
  }

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await this.api(accessToken, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}`);
  }

  async insertEvent(accessToken: string, calendarId: string, event: GoogleEventPayload): Promise<string> {
    const body = await this.api(accessToken, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, event);
    return body.id;
  }

  async updateEvent(accessToken: string, calendarId: string, eventId: string, event: GoogleEventPayload): Promise<void> {
    await this.api(accessToken, 'PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, event);
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    await this.api(accessToken, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  private cacheAccessToken(refreshToken: string, accessToken: string, expiresIn: number): void {
    const ttlMs = Math.max(0, (Number(expiresIn) || 3600) - 60) * 1000;
    this.tokenCache.set(sha256Hex(refreshToken), { token: accessToken, expiresAt: Date.now() + ttlMs });
  }

  private async tokenRequest(form: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!res.ok) {
      const code = body.error || `HTTP ${res.status}`;
      if (code === 'invalid_grant' || res.status === 401) {
        throw new GoogleAuthRevokedError(`Google token request rejected: ${code}`, res.status);
      }
      throw new GoogleApiError(`Google token request failed: ${code}`, res.status);
    }
    return body;
  }

  private async api(accessToken: string, method: string, path: string, payload?: unknown): Promise<any> {
    const res = await this.fetchImpl(`${CALENDAR_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(payload !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (res.ok) return body;
    const message = `Google Calendar ${method} ${path.split('/')[1]} failed (HTTP ${res.status}): ${body?.error?.message || 'sem detalhes'}`;
    if (res.status === 401) throw new GoogleAuthRevokedError(message, res.status);
    if (res.status === 404 || res.status === 410) throw new GoogleNotFoundError(message, res.status);
    if (res.status === 409) throw new GoogleConflictError(message, res.status);
    throw new GoogleApiError(message, res.status);
  }
}
