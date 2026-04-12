import { IPackageRepository } from '../../domain/repositories/IPackageRepository';
import { Package } from '../../domain/entities/Package';

export class ListPackagesUseCase {
  constructor(private readonly packageRepository: IPackageRepository) {}

  async execute(): Promise<Package[]> {
    return this.packageRepository.findAll();
  }
}
