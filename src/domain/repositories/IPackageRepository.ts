import { Package } from '../entities/Package';

export interface IPackageRepository {
  findAll(): Promise<Package[]>;
  findById(id: number): Promise<Package | null>;
  findBySessionCount(sessions: number): Promise<Package | null>;
}
