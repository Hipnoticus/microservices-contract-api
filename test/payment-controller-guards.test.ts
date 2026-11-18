import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PaymentController } from '../src/interfaces/http/controllers/PaymentController';

// Incident 20261118: webhook/register and confirm/:orderId were callable by anyone who reached ContractAPI.
describe('PaymentController guards', () => {
  const guards = (method: keyof PaymentController) =>
    Reflect.getMetadata(GUARDS_METADATA, (PaymentController.prototype as any)[method]) as any[] | undefined;

  test('webhook/register and confirm require a staff guard', () => {
    expect(guards('registerWebhooks')?.length).toBe(1);
    expect(guards('confirmOrder')?.length).toBe(1);
  });

  test('the Banco Inter callback and checkout stay public (they verify instead)', () => {
    expect(guards('bancoInterWebhook')).toBeUndefined();
    expect(guards('process')).toBeUndefined();
  });

  test('the staff guard refuses a request without a token', () => {
    const Guard = guards('registerWebhooks')![0];
    const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
    expect(() => new Guard().canActivate(ctx)).toThrow();
  });
});
