import { Controller, Get, Post, Param, Body, Inject } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Create a new order/contract with customer data' })
  async create(@Body() dto: CreateOrderDTO) {
    return this.createOrder.execute(dto);
  }
}
