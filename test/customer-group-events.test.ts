import { describe, expect, it } from 'bun:test';
import { createServer } from 'net';
import { CUSTOMER_GROUP_CHANGED, publishCustomerGroupChanged, respCommand } from '../src/infrastructure/events/CustomerGroupEvents';

describe('customer.group.changed publisher', () => {
  it('encodes a Redis command in RESP with byte lengths', () => {
    expect(respCommand(['PUBLISH', 'c', 'á'])).toBe('*3\r\n$7\r\nPUBLISH\r\n$1\r\nc\r\n$2\r\ná\r\n');
  });

  it('publishes the customer id on the channel and resolves true on an integer reply', async () => {
    let received = '';
    const server = createServer((s) => s.on('data', (d) => { received += d.toString(); s.write(':1\r\n'); }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const ok = await publishCustomerGroupChanged(43, 1, 'contract-api', { host: '127.0.0.1', port });
    server.close();
    expect(ok).toBe(true);
    expect(received).toContain(CUSTOMER_GROUP_CHANGED);
    expect(received).toContain('{"customerId":43,"groupId":1,"source":"contract-api"}');
  });

  it('never throws when Redis is unreachable, and ignores invalid ids', async () => {
    expect(await publishCustomerGroupChanged(43, 1, 'contract-api', { host: '127.0.0.1', port: 1 })).toBe(false);
    expect(await publishCustomerGroupChanged(0, 1)).toBe(false);
  });
});
