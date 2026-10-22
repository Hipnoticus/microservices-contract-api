import { Controller, Get, Post, Put, Delete, Param, Body, Inject, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import { CustomerCard } from '../../../infrastructure/persistence/models/CustomerCardModel';
import { CieloGateway } from '../../../infrastructure/payment/CieloGateway';
import { Logger } from '../../../shared/logger/Logger';
import { requireCustomerOrStaff } from '../auth/StaffAuth';

const logger = new Logger('CustomerCardController');

/**
 * Saved cards. Every action checks the token here: the card owner (customer token) or staff with Clientes.
 * The customer id is in the body or behind a card id, which the gateway's path rules cannot see.
 */
@Controller('cards')
export class CustomerCardController {
  constructor(
    @Inject('DATABASE') private readonly db: Sequelize,
    @Inject('CIELO_GATEWAY') private readonly cielo: CieloGateway | null,
  ) {}

  private async ownerOf(cardId: string): Promise<number> {
    const card = await CustomerCard.findOne({ where: { id: parseInt(cardId, 10) || 0 } });
    if (!card) throw new HttpException({ error: 'Cartão não encontrado.' }, HttpStatus.NOT_FOUND);
    return Number(card.customerID);
  }

  @Get('customer/:customerId')
  async getCardsByCustomer(@Headers('authorization') auth: string, @Param('customerId') customerId: string) {
    requireCustomerOrStaff(auth, parseInt(customerId, 10));
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
  async tokenizeCard(@Headers('authorization') auth: string, @Body() body: {
    customerId: number;
    cardNumber: string;
    holderName: string;
    expirationDate: string;
    brand: string;
    alias?: string;
  }) {
    requireCustomerOrStaff(auth, Number(body?.customerId));
    if (!this.cielo) {
      return { success: false, error: 'Cielo gateway not configured' };
    }

    try {
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

      // Same last 4 digits + brand + customer: refresh the token instead of duplicating the card
      const existing = await CustomerCard.findOne({
        where: { customerID: body.customerId, lastFourDigits: lastFour, brand: body.brand, blocked: false },
      });

      if (existing) {
        existing.cardToken = tokenResult.cardToken;
        existing.holderName = body.holderName;
        existing.expirationDate = body.expirationDate;
        existing.dateModified = new Date();
        if (body.alias) existing.alias = body.alias;
        await existing.save();
        logger.info(`Updated card token for customer ${body.customerId}, card ****${lastFour}`);
        return { success: true, cardId: existing.id, message: 'Cartão atualizado com sucesso' };
      }

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
  async setDefault(@Headers('authorization') auth: string, @Param('id') id: string) {
    // The owner comes from the card itself, not from the body
    const customerId = await this.ownerOf(id);
    requireCustomerOrStaff(auth, customerId);
    await CustomerCard.update({ isDefault: false, dateModified: new Date() }, { where: { customerID: customerId } });
    await CustomerCard.update({ isDefault: true, dateModified: new Date() }, { where: { id: parseInt(id, 10), customerID: customerId } });
    return { success: true };
  }

  @Delete(':id')
  async deleteCard(@Headers('authorization') auth: string, @Param('id') id: string) {
    requireCustomerOrStaff(auth, await this.ownerOf(id));
    await CustomerCard.update({ blocked: true, dateModified: new Date() }, { where: { id: parseInt(id, 10) } });
    return { success: true };
  }
}
