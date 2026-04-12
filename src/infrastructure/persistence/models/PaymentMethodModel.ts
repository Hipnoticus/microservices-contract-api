import { DataTypes, Model, Sequelize } from 'sequelize';

export class PaymentMethodModel extends Model {
  declare id: number;
  declare name: string | null;
  declare description: string | null;
  declare parcelas: number | null;
  declare idExt: string | null;
  declare blocked: boolean | null;
}

export function initializePaymentMethodModel(sequelize: Sequelize): void {
  PaymentMethodModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'ID' },
      name: { type: DataTypes.STRING(100), field: 'Name' },
      description: { type: DataTypes.TEXT, field: 'Description' },
      parcelas: { type: DataTypes.INTEGER, field: 'Parcelas' },
      idExt: { type: DataTypes.STRING(100), field: 'IDExt' },
      blocked: { type: DataTypes.BOOLEAN, field: 'Blocked' },
    },
    { sequelize, tableName: 'tbFormasPagamento', timestamps: false },
  );
}
