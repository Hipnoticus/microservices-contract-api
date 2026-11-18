import { Controller, Get, Post, Param, Body, Inject, Req } from '@nestjs/common';
import { clientIp, userAgent } from '../ClientIp';
import { orderRateLimiter } from '../RateLimiter';
import { verifyStaffToken } from '../auth/StaffAuth';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CreateOrderUseCase, CreateOrderDTO } from '../../../application/use-cases/CreateOrderUseCase';
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
  @ApiOperation({ summary: 'Create a new order/contract with customer data (public; validated, rate limited per IP)' })
  async create(@Body() dto: CreateOrderDTO, @Req() req: any) {
    const ip = clientIp(req);
    // Public sign-up: ORDER_RATE_LIMIT_PER_HOUR per IP (429). A verified staff token is not limited.
    if (!verifyStaffToken(req?.headers?.authorization)) orderRateLimiter.check(ip, 'cadastro');
    return this.createOrder.execute(dto, { ip, userAgent: userAgent(req) });
  }
}
