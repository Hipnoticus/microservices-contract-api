import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Sequelize, QueryTypes } from 'sequelize';

@ApiTags('Config')
@Controller('config')
export class ConfigController {
  constructor(@Inject('DATABASE') private readonly sequelize: Sequelize) {}

  @Get('payment')
  @ApiOperation({ summary: 'Get payment-related configuration for the frontend' })
  async getPaymentConfig() {
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE 'orders.transaction%' OR Name LIKE 'orders.status%' ORDER BY Name`,
      { type: QueryTypes.SELECT },
    ) as any[];

    const cfg: Record<string, string> = {};
    for (const r of rows) {
      if (r?.Name) cfg[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
    }

    return {
      maxInstallments: parseInt(cfg['orders.transaction.max_installments'] || '5', 10),
      testEmail: cfg['orders.transaction.test.email'] || '',
      testValue: parseFloat((cfg['orders.transaction.test.value'] || '0.01').replace(',', '.')),
      testValueBoleto: parseFloat((cfg['orders.transaction.test.value_boleto'] || '1.00').replace(',', '.')),
      defaultOrderStatus: parseInt(cfg['orders.status.default'] || '1', 10),
      bankData: cfg['orders.transaction.bank.data'] || '',
    };
  }

  @Get('test-card')
  @ApiOperation({ summary: 'Get test card data for payment testing (server-side only)' })
  async getTestCardData() {
    // Test card data lives here on the server, never in the frontend bundle.
    // Mirrors legacy PreencherCartaoTeste() from PacotesContratar.aspx.cs
    const rows = await this.sequelize.query(
      `SELECT Name, Value FROM tbConfig WHERE Name LIKE 'orders.transaction.test%' ORDER BY Name`,
      { type: QueryTypes.SELECT },
    ) as any[];

    const cfg: Record<string, string> = {};
    for (const r of rows) {
      if (r?.Name) cfg[r.Name] = (r.Value || '').replace(/<\/?p>/g, '').trim();
    }

    return {
      cardNumber: cfg['orders.transaction.test.card.number'] || '2306502978218784',
      cardHolder: cfg['orders.transaction.test.card.holder'] || 'GABRIEL VELOSO',
      cardExpiration: cfg['orders.transaction.test.card.expiration'] || '05/2030',
      cardCvv: cfg['orders.transaction.test.card.cvv'] || '727',
      cardBrand: cfg['orders.transaction.test.card.brand'] || 'Master',
    };
  }
}
