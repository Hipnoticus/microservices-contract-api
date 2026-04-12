import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ListPackagesUseCase } from '../../../application/use-cases/ListPackagesUseCase';

@ApiTags('Packages')
@Controller('packages')
export class PackageController {
  constructor(private readonly listPackages: ListPackagesUseCase) {}

  @Get()
  @ApiOperation({ summary: 'List all available packages' })
  async findAll() {
    return this.listPackages.execute();
  }
}
