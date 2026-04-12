import { DataTypes, Model, Sequelize } from 'sequelize';

export class OrderStatusModel extends Model {
  declare id: number;
  declare name: string | null;
}

export function initializeOrderStatusModel(sequelize: Sequelize): void {
  OrderStatusModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'ID' },
      name: { type: DataTypes.STRING(150), field: 'Name' },
    },
    { sequelize, tableName: 'tbOrdersStatus', timestamps: false },
  );
}
