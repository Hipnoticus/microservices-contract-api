import { DataTypes, Model, Sequelize } from 'sequelize';

export class OrderModel extends Model {
  declare id: number;
  declare customerId: number | null;
  declare customerEmail: string | null;
  declare customerAddressId: number | null;
  declare orderStatusId: number | null;
  declare mainGoal: string | null;
  declare formaPagamento: number | null;
  declare subTotal: number | null;
  declare total: number | null;
  declare shipValue: number | null;
  declare identifier: string | null;
  declare registry: string | null;
  declare firstAppointmentDay: number | null;
  declare firstAppointmentHour: string | null;
  declare treatment: number | null;
  declare sessionDay: number | null;
  declare sessionHour: string | null;
  declare blocked: boolean | null;
  declare dateCreated: Date | null;
  declare dateModified: Date | null;
  declare createdBy: number | null;
  declare modifiedBy: number | null;
}

export function initializeOrderModel(sequelize: Sequelize): void {
  OrderModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'ID' },
      customerId: { type: DataTypes.INTEGER, field: 'CustomerID' },
      customerEmail: { type: DataTypes.STRING(255), field: 'CustomerEmail' },
      customerAddressId: { type: DataTypes.INTEGER, field: 'CustomerAddressID' },
      orderStatusId: { type: DataTypes.INTEGER, field: 'OrderStatusID' },
      mainGoal: { type: DataTypes.STRING(255), field: 'MainGoal' },
      formaPagamento: { type: DataTypes.INTEGER, field: 'FormaPagamento' },
      subTotal: { type: DataTypes.DECIMAL(10, 2), field: 'SubTotal' },
      total: { type: DataTypes.DECIMAL(10, 2), field: 'Total' },
      shipValue: { type: DataTypes.DECIMAL(10, 2), field: 'ShipValue' },
      identifier: { type: DataTypes.STRING(255), field: 'Identifier' },
      registry: { type: DataTypes.STRING(255), field: 'Registry' },
      firstAppointmentDay: { type: DataTypes.INTEGER, field: 'FirstAppointmentDay' },
      firstAppointmentHour: { type: DataTypes.STRING(255), field: 'FirstAppointmentHour' },
      treatment: { type: DataTypes.INTEGER, field: 'Treatment' },
      sessionDay: { type: DataTypes.INTEGER, field: 'SessionDay' },
      sessionHour: { type: DataTypes.STRING(255), field: 'SessionHour' },
      blocked: { type: DataTypes.BOOLEAN, field: 'Blocked' },
      dateCreated: { type: DataTypes.DATE, field: 'DateCreated' },
      dateModified: { type: DataTypes.DATE, field: 'DateModified' },
      createdBy: { type: DataTypes.INTEGER, field: 'CreatedBy' },
      modifiedBy: { type: DataTypes.INTEGER, field: 'ModifiedBy' },
    },
    { sequelize, tableName: 'tbOrders', timestamps: false },
  );
}
