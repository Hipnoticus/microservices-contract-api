import { createHmac } from 'crypto';

/**
 * LiveKit access token (a HS256 JWT signed with the LiveKit API secret), built here so ContractAPI needs no SDK.
 * Claim layout from LiveKit's token format: iss = API key, sub = identity, video = grants for one room.
 */
export interface LiveKitGrant {
  room: string;
  identity: string;
  name: string;
  ttlSeconds: number;
  metadata?: Record<string, unknown>;
  /** Room admin (the therapist): may mute or remove participants. */
  admin?: boolean;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function liveKitToken(apiKey: string, apiSecret: string, g: LiveKitGrant, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!apiKey || !apiSecret || apiSecret.length < 32) throw new Error('LiveKit API key/secret not configured');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: apiKey,
    sub: g.identity,
    name: g.name,
    nbf: nowSeconds - 5,
    exp: nowSeconds + g.ttlSeconds,
    metadata: g.metadata ? JSON.stringify(g.metadata) : undefined,
    video: {
      room: g.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: !!g.admin,
    },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', apiSecret).update(unsigned).digest();
  return `${unsigned}.${b64url(sig)}`;
}
