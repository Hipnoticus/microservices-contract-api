import { Socket, connect } from 'net';

/**
 * Publishes `customer.group.changed` on the shared Redis (`redis:6379` on the hipnoticus network, dev and prod) when
 * ContractAPI changes tbCustomers.GroupID, so CouponAPI grants or revokes VIP (group 1) access in the apps in real
 * time. Payload: {"customerId":43,"groupId":1,"source":"contract-api"}; CouponAPI re-reads the group from CustomerAPI.
 *
 * One PUBLISH over a short-lived TCP connection in the Redis protocol, so ContractAPI needs no Redis client
 * dependency. Fire-and-forget: errors are logged and never fail the order or admin change; the apps also re-check the
 * group on every token refresh.
 */
export const CUSTOMER_GROUP_CHANGED = 'customer.group.changed';

export function respCommand(args: string[]): string {
  return `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a, 'utf8')}\r\n${a}\r\n`).join('');
}

export function publishCustomerGroupChanged(
  customerId: number,
  groupId: number | null,
  source = 'contract-api',
  target = redisTarget(),
): Promise<boolean> {
  if (!Number.isInteger(customerId) || customerId <= 0) return Promise.resolve(false);
  const payload = JSON.stringify({ customerId, groupId, source });
  return new Promise((resolve) => {
    let done = false;
    let socket: Socket;
    const finish = (ok: boolean, why?: string) => {
      if (done) return;
      done = true;
      if (!ok) console.warn(`[CustomerGroupEvents] ${CUSTOMER_GROUP_CHANGED} for customer ${customerId} not published: ${why}`);
      socket?.destroy();
      resolve(ok);
    };
    socket = connect(target.port, target.host, () => socket.write(respCommand(['PUBLISH', CUSTOMER_GROUP_CHANGED, payload])));
    socket.setTimeout(3000, () => finish(false, 'timeout'));
    socket.on('data', (chunk) => {
      const reply = chunk.toString('utf8');
      finish(reply.startsWith(':'), reply.trim());
    });
    socket.on('error', (e) => finish(false, e.message));
  });
}

function redisTarget(): { host: string; port: number } {
  const host = (process.env.REDIS_EVENTS_HOST || 'redis').trim();
  const port = parseInt(process.env.REDIS_EVENTS_PORT || '6379', 10);
  return { host, port: Number.isFinite(port) ? port : 6379 };
}
