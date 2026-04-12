import { IPackageRepository } from '../../../domain/repositories/IPackageRepository';
import { Package } from '../../../domain/entities/Package';
import { PackageModel } from '../models/PackageModel';
import { Op } from 'sequelize';

export class SequelizePackageRepository implements IPackageRepository {
  async findAll(): Promise<Package[]> {
    const models = await PackageModel.findAll({ order: [['id', 'ASC']] });
    return models.map((m) => this.toDomain(m));
  }

  async findById(id: number): Promise<Package | null> {
    const model = await PackageModel.findByPk(id);
    return model ? this.toDomain(model) : null;
  }

  async findBySessionCount(sessions: number): Promise<Package | null> {
    // Product names contain session count like "10 Sessões"
    const model = await PackageModel.findOne({
      where: { name: { [Op.like]: `${sessions} Sess%` } },
    });
    return model ? this.toDomain(model) : null;
  }

  private toDomain(model: PackageModel): Package {
    const normalPrice = Number(model.normalPrice) || 0;
    const promoPrice = Number(model.promotionalPrice) || normalPrice;
    const discount = normalPrice > 0 ? Math.round((1 - promoPrice / normalPrice) * 100) : 0;
    return new Package(
      model.id,
      model.name || '',
      this.extractSessions(model.name),
      promoPrice,
      normalPrice,
      discount,
      model.description || '',
      !model.blocked,
    );
  }

  private extractSessions(name: string | null): number {
    if (!name) return 0;
    const match = name.match(/(\d+)\s*Sess/i);
    return match ? parseInt(match[1], 10) : 0;
  }
}
