import { Sequelize, DataTypes, Model } from 'sequelize';

export class CustomerCard extends Model {
  declare id: number;
  declare customerID: number;
  declare cardToken: string;
  declare brand: string;
  declare lastFourDigits: string;
  declare holderName: string;
  declare expirationDate: string;
  declare isDefault: boolean;
  declare alias: string | null;
  declare blocked: boolean;
  declare dateCreated: Date;
  declare dateModified: Date;
}

export function initializeCustomerCardModel(sequelize: Sequelize): void {
  CustomerCard.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, field: 'ID' },
    customerID: { type: DataTypes.INTEGER, allowNull: false, field: 'CustomerID' },
    cardToken: { type: DataTypes.STRING(100), allowNull: false, field: 'CardToken' },
    brand: { type: DataTypes.STRING(20), allowNull: false, field: 'Brand' },
    lastFourDigits: { type: DataTypes.STRING(4), allowNull: false, field: 'LastFourDigits' },
    holderName: { type: DataTypes.STRING(100), allowNull: false, field: 'HolderName' },
    expirationDate: { type: DataTypes.STRING(7), allowNull: false, field: 'ExpirationDate' },
    isDefault: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'IsDefault' },
    alias: { type: DataTypes.STRING(50), allowNull: true, field: 'Alias' },
    blocked: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'Blocked' },
    dateCreated: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'DateCreated' },
    dateModified: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'DateModified' },
  }, {
    sequelize,
    tableName: 'tbCustomerCards',
    schema: 'dbo',
    timestamps: false,
  });
}
