/**
 * Order aggregate root.
 * Represents a contract/purchase for a treatment package.
 */
export class Order {
  constructor(
    public readonly id: number,
    public readonly customerId: number,
    public readonly statusId: number,
    public readonly mainGoal: string,
    public readonly paymentMethodId: number,
    public readonly paymentIdentifier: string | null,
    public readonly paymentRegistry: string | null,
    public readonly firstAppointmentDay: string,
    public readonly firstAppointmentHour: string,
    public readonly sessionDay: string,
    public readonly sessionHour: string,
    public readonly subTotal: number,
    public readonly total: number,
    public readonly installments: number,
    public readonly packageSize: number,
    public readonly blocked: boolean,
    public readonly dateCreated: Date,
    public readonly dateModified: Date,
    public readonly createdBy: number,
    public readonly modifiedBy: number,
  ) {}
}
