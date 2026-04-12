import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PaymentMethodModel } from '../../../infrastructure/persistence/models/PaymentMethodModel';
import { OrderStatusModel } from '../../../infrastructure/persistence/models/OrderStatusModel';

@ApiTags('Payment Methods')
@Controller('payment-methods')
export class PaymentMethodController {
  @Get()
  @ApiOperation({ summary: 'List all payment methods' })
  async findAll() {
    return PaymentMethodModel.findAll({ where: { blocked: false }, order: [['id', 'ASC']] });
  }
}

@ApiTags('Order Statuses')
@Controller('order-statuses')
export class OrderStatusController {
  @Get()
  @ApiOperation({ summary: 'List all order statuses' })
  async findAll() {
    return OrderStatusModel.findAll({ order: [['id', 'ASC']] });
  }
}
