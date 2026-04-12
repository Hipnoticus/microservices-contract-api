/**
 * Payment method value object.
 */
export enum PaymentType {
  CREDIT_CARD = 1,
  PIX_DEPOSIT = 2,
  BOLETO = 3,
  ITAU_SHOPLINE = 4,
}

export class PaymentMethod {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly identifier: string | null,
    public readonly registry: string | null,
  ) {}
}
