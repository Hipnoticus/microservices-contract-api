import { Controller, Get, Post, Put, Delete, Param, Body, Inject } from '@nestjs/common';
import { Sequelize, QueryTypes } from 'sequelize';
import { CustomerCard } from '../../../infrastructure/persistence/models/CustomerCardModel';
import { CieloGateway } from '../../../infrastructure/payment/CieloGateway';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('CustomerCardController');

@Controller('cards')
export class CustomerCardController {
  constructor(
    @Inject('DATABASE') private readonly db: Sequelize,
    @Inject('CIELO_GATEWAY') private readonly cielo: CieloGateway | null,
  ) {}

  @Get('customer/:customerId')
  async getCardsByCustomer(@Param('customerId') customerId: string) {
    const cards = await CustomerCard.findAll({
      where: { customerID: parseInt(customerId, 10), blocked: false },
      order: [['isDefault', 'DESC'], ['dateCreated', 'DESC']],
    });
    return cards.map(c => ({
      id: c.id,
      brand: c.brand,
      lastFourDigits: c.lastFourDigits,
      holderName: c.holderName,
      expirationDate: c.expirationDate,
      isDefault: c.isDefault,
      alias: c.alias || `${c.brand} ****${c.lastFourDigits}`,
    }));
  }

  @Post('tokenize')
  async tokenizeCard(@Body() body: {
    customerId: number;
    cardNumber: string;
    holderName: string;
    expirationDate: string;
    brand: string;
    alias?: string;
  }) {
    if (!this.cielo) {
      return { success: false, error: 'Cielo gateway not configured' };
    }

    try {
      // Call Cielo tokenization API
      const tokenResult = await this.cielo.tokenizeCard({
        customerName: body.holderName,
        cardNumber: body.cardNumber,
        holder: body.holderName,
        expirationDate: body.expirationDate,
        brand: body.brand,
      });

      if (!tokenResult.cardToken) {
        return { success: false, error: 'Failed to tokenize card' };
      }

      const lastFour = body.cardNumber.slice(-4);

      // Check if card already exists (same last 4 digits + brand + customer)
      const existing = await CustomerCard.findOne({
        where: { customerID: body.customerId, lastFourDigits: lastFour, brand: body.brand, blocked: false },
      });

      if (existing) {
        // Update the token
        existing.cardToken = tokenResult.cardToken;
        existing.holderName = body.holderName;
        existing.expirationDate = body.expirationDate;
        existing.dateModified = new Date();
        if (body.alias) existing.alias = body.alias;
        await existing.save();
        logger.info(`Updated card token for customer ${body.customerId}, card ****${lastFour}`);
        return { success: true, cardId: existing.id, message: 'Cartão atualizado com sucesso' };
      }

      // Check if this is the first card — make it default
      const cardCount = await CustomerCard.count({ where: { customerID: body.customerId, blocked: false } });

      const card = await CustomerCard.create({
        customerID: body.customerId,
        cardToken: tokenResult.cardToken,
        brand: body.brand,
        lastFourDigits: lastFour,
        holderName: body.holderName,
        expirationDate: body.expirationDate,
        isDefault: cardCount === 0,
        alias: body.alias || `${body.brand} ****${lastFour}`,
      });

      logger.info(`Tokenized card for customer ${body.customerId}: ${body.brand} ****${lastFour}`);
      return { success: true, cardId: card.id, message: 'Cartão salvo com sucesso' };
    } catch (err: any) {
      logger.error(`Card tokenization failed: ${err.message}`);
      return { success: false, error: err.message || 'Erro ao tokenizar cartão' };
    }
  }

  @Put(':id/default')
  async setDefault(@Param('id') id: string, @Body() body: { customerId: number }) {
    // Remove default from all cards for this customer
    await CustomerCard.update(
      { isDefault: false, dateModified: new Date() },
      { where: { customerID: body.customerId } }
    );
    // Set the selected card as default
    await CustomerCard.update(
      { isDefault: true, dateModified: new Date() },
      { where: { id: parseInt(id, 10), customerID: body.customerId } }
    );
    return { success: true };
  }

  @Delete(':id')
  async deleteCard(@Param('id') id: string) {
    await CustomerCard.update(
      { blocked: true, dateModified: new Date() },
      { where: { id: parseInt(id, 10) } }
    );
    return { success: true };
  }
}
