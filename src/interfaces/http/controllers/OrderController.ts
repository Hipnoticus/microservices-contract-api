import { Controller, Get, Post, Param, Body, Inject, Req } from '@nestjs/common';
import { clientIp, userAgent } from '../ClientIp';
import { orderRateLimiter } from '../RateLimiter';
import { verifyStaffToken } from '../auth/StaffAuth';
import { requireTurnstile, TURNSTILE_BODY_FIELD } from '../Turnstile';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CreateOrderUseCase, type CreateOrderDTO } from '../../../application/use-cases/CreateOrderUseCase';
import { SequelizeOrderRepository } from '../../../infrastructure/persistence/repositories/SequelizeOrderRepository';

@ApiTags('Orders')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly createOrder: CreateOrderUseCase,
    @Inject('ORDER_REPOSITORY') private readonly orderRepository: SequelizeOrderRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all orders' })
  async findAll() {
    return this.orderRepository.findAll();
  }

  @Get('customer/:customerId')
  @ApiOperation({ summary: 'Get orders by customer ID' })
  async findByCustomer(@Param('customerId') customerId: number) {
    return this.orderRepository.findByCustomerId(customerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  async findById(@Param('id') id: number) {
    return this.orderRepository.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new order/contract with customer data (public; Turnstile token in body.turnstileToken, validated, rate limited per IP)' })
  async create(@Body() dto: CreateOrderDTO, @Req() req: any) {
    const ip = clientIp(req);
    // The Turnstile token is not order data: keep it out of the order and the "Dados enviados" e-mail.
    const { [TURNSTILE_BODY_FIELD]: turnstileToken, ...order } = (dto && typeof dto === 'object' ? dto : {}) as any;
    // Public sign-up: ORDER_RATE_LIMIT_PER_HOUR per IP (429) and a Cloudflare Turnstile token (403).
    // A verified staff token skips both; customers and anonymous visitors do not.
    if (!verifyStaffToken(req?.headers?.authorization)) {
      orderRateLimiter.check(ip, 'cadastro');
      await requireTurnstile(turnstileToken, ip, 'POST /orders');
    }
    return this.createOrder.execute(order as CreateOrderDTO, { ip, userAgent: userAgent(req) });
  }
}
