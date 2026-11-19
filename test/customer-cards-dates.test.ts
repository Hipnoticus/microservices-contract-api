import 'reflect-metadata';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { Sequelize } from 'sequelize';
import { CustomerCard, initializeCustomerCardModel } from '../src/infrastructure/persistence/models/CustomerCardModel';
import { CustomerCardController } from '../src/interfaces/http/controllers/CustomerCardController';
import { boletoPageUrl } from '../src/application/use-cases/ProcessPaymentUseCase';

// tbCustomerCards.DateModified is datetime: a JS Date became '... +00:00', which SQL Server refused with
// "Conversion failed when converting date and/or time", so PUT /cards/:id/default and DELETE /cards/:id were 500.
const KEY = 'test-secret-test-secret-test-secret-42';
process.env.JWT_HS256_KEY = KEY;
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload: any) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return `Bearer ${h}.${p}.${createHmac('sha256', KEY).update(`${h}.${p}`).digest('base64url')}`;
}
const customer43 = token({ sub: '43', type: 'customer', exp: Math.floor(Date.now() / 1000) + 3600 });

const sequelize = new Sequelize({ dialect: 'mssql', logging: false });
initializeCustomerCardModel(sequelize);
let sql: string[] = [];
(sequelize as any).query = async (q: any, opts: any) => {
  sql.push(typeof q === 'string' ? q : q.query);
  return opts?.instance ? [opts.instance, 1] : [[], 1];
};
(CustomerCard as any).findOne = async () => ({ customerID: 43 });
const controller = new CustomerCardController(sequelize, null);
const noOffsetDate = (s: string) => expect(s).not.toMatch(/\d{2}:\d{2}:\d{2}(\.\d+)? [+-]\d{2}:\d{2}/);

describe('tbCustomerCards date writes', () => {
  beforeEach(() => { sql = []; });

  test('setting the default card writes DateModified with GETDATE()', async () => {
    expect(await controller.setDefault(customer43, '9')).toEqual({ success: true });
    expect(sql.length).toBe(2);
    for (const s of sql) { expect(s).toMatch(/\[DateModified\]=GETDATE\(\)/); noOffsetDate(s); }
  });

  test('deleting a card writes DateModified with GETDATE()', async () => {
    expect(await controller.deleteCard(customer43, '9')).toEqual({ success: true });
    expect(sql[0]).toMatch(/SET \[Blocked\]=/);
    expect(sql[0]).toMatch(/\[DateModified\]=GETDATE\(\)/);
    noOffsetDate(sql[0]);
  });

  test('a new card gets DateCreated/DateModified from GETDATE()', async () => {
    await CustomerCard.create({ customerID: 43, cardToken: 't', brand: 'Visa', lastFourDigits: '1111', holderName: 'X', expirationDate: '12/2030' });
    expect(sql[0]).toContain('GETDATE()');
    noOffsetDate(sql[0]);
  });
});

// The e-mail cannot carry a token, so its boleto link is the Moses page (login, then the PDF), never the API route.
describe('boleto link in the e-mails', () => {
  test('points to the Moses boleto page', () => {
    expect(boletoPageUrl('12345678901', 'https://moses.hipnoticus.com.br/')).toBe('https://moses.hipnoticus.com.br/boleto/12345678901');
    expect(boletoPageUrl('a/b', 'http://localhost:4200')).toBe('http://localhost:4200/boleto/a%2Fb');
    expect(boletoPageUrl('', 'x')).toBe('');
    expect(boletoPageUrl(null)).toBe('');
  });
});