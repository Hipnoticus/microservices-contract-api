import { DataTypes, Model, Sequelize } from 'sequelize';

/** Maps to tbProducts — treatment packages (sessions bundles). */
export class PackageModel extends Model {
  declare id: number;
  declare name: string | null;
  declare description: string | null;
  declare normalPrice: number | null;
  declare promotionalPrice: number | null;
  declare category: number | null;
  declare blocked: boolean | null;
}

export function initializePackageModel(sequelize: Sequelize): void {
  PackageModel.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'ID' },
      name: { type: DataTypes.STRING(255), field: 'Name' },
      description: { type: DataTypes.TEXT, field: 'Description' },
      normalPrice: { type: DataTypes.DECIMAL(19, 4), field: 'NormalPrice' },
      promotionalPrice: { type: DataTypes.DECIMAL(19, 4), field: 'PromotionalPrice' },
      category: { type: DataTypes.INTEGER, field: 'Category' },
      blocked: { type: DataTypes.BOOLEAN, field: 'Blocked' },
    },
    { sequelize, tableName: 'tbProducts', timestamps: false },
  );
}
