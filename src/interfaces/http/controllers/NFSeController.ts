import { Controller, Get, Post, Put, Param, Body, Query, Inject } from '@nestjs/common';
import { Sequelize, QueryTypes } from 'sequelize';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('NFSeController');

@Controller('nfse')
export class NFSeController {
  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  /** List all NFS-e with filters */
  @Get()
  async list(@Query('customerId') customerId?: string, @Query('status') status?: string, @Query('orderId') orderId?: string) {
    let where = 'WHERE n.Blocked = 0';
    const replacements: any = {};
    if (customerId) { where += ' AND n.CustomerID = :customerId'; replacements.customerId = parseInt(customerId, 10); }
    if (status) { where += ' AND n.Status = :status'; replacements.status = parseInt(status, 10); }
    if (orderId) { where += ' AND n.OrderID = :orderId'; replacements.orderId = parseInt(orderId, 10); }

    const nfses = await this.db.query(`
      SELECT n.*, c.FirstName + ' ' + c.LastName as CustomerName
      FROM tbNFSe n
      LEFT JOIN tbCustomers c ON c.ID = n.CustomerID
      ${where}
      ORDER BY n.DateCreated DESC
    `, { replacements, type: QueryTypes.SELECT });

    return nfses;
  }

  /** Get single NFS-e by ID */
  @Get(':id')
  async getById(@Param('id') id: string) {
    const [nfse] = await this.db.query(`
      SELECT n.*, c.FirstName + ' ' + c.LastName as CustomerName, c.Email as CustomerEmail
      FROM tbNFSe n
      LEFT JOIN tbCustomers c ON c.ID = n.CustomerID
      WHERE n.ID = :id
    `, { replacements: { id: parseInt(id, 10) }, type: QueryTypes.SELECT }) as any[];

    return nfse || null;
  }

  /** Create a draft NFS-e */
  @Post()
  async create(@Body() body: {
    orderId?: number;
    sessionId?: number;
    customerId: number;
    value: number;
    serviceDescription?: string;
  }) {
    // Get customer data
    const [customer] = await this.db.query(
      'SELECT ID, FirstName, LastName, CPFCNPJ, Email FROM tbCustomers WHERE ID = :id',
      { replacements: { id: body.customerId }, type: QueryTypes.SELECT }
    ) as any[];

    if (!customer) return { success: false, error: 'Cliente não encontrado' };

    // Get config
    const configs = await this.db.query('SELECT ConfigKey, ConfigValue FROM tbNFSeConfig', { type: QueryTypes.SELECT }) as any[];
    const cfg = Object.fromEntries(configs.map((c: any) => [c.ConfigKey, c.ConfigValue]));

    const issRate = parseFloat(cfg.ISSRate || '5.00');
    const issValue = Math.round(body.value * issRate) / 100;

    const [result] = await this.db.query(`
      INSERT INTO tbNFSe (OrderID, SessionID, CustomerID, CNPJ, InscricaoMunicipal,
        ServiceCode, ServiceDescription, Value, ISSRate, ISSValue,
        TomadorCPFCNPJ, TomadorName, TomadorEmail, Status, Name, Description)
      OUTPUT INSERTED.ID
      VALUES (:orderId, :sessionId, :customerId, :cnpj, :im,
        :serviceCode, :serviceDesc, :value, :issRate, :issValue,
        :cpf, :name, :email, 1, :name, :serviceDesc)
    `, {
      replacements: {
        orderId: body.orderId || null,
        sessionId: body.sessionId || null,
        customerId: body.customerId,
        cnpj: cfg.CNPJ || '12344385000193',
        im: cfg.InscricaoMunicipal || '',
        serviceCode: cfg.ServiceCode || '8690-9/99',
        serviceDesc: body.serviceDescription || cfg.ServiceDescription || 'Serviços de hipnoterapia clínica',
        value: body.value,
        issRate,
        issValue,
        cpf: customer.CPFCNPJ || '',
        name: `${customer.FirstName} ${customer.LastName}`,
        email: customer.Email || '',
      },
      type: QueryTypes.INSERT,
    });

    logger.info(`NFS-e draft created for customer ${body.customerId}, value R$ ${body.value}`);
    return { success: true, id: (result as any)?.ID || (result as any)?.[0]?.ID, message: 'NFS-e criada como rascunho' };
  }

  /** Update NFS-e */
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const fields: string[] = [];
    const replacements: any = { id: parseInt(id, 10) };

    if (body.serviceDescription !== undefined) { fields.push('ServiceDescription = :serviceDesc'); replacements.serviceDesc = body.serviceDescription; }
    if (body.value !== undefined) { fields.push('Value = :value'); replacements.value = body.value; }
    if (body.issRate !== undefined) { fields.push('ISSRate = :issRate'); replacements.issRate = body.issRate; }
    if (body.status !== undefined) { fields.push('Status = :status'); replacements.status = body.status; }
    if (body.statusMessage !== undefined) { fields.push('StatusMessage = :statusMsg'); replacements.statusMsg = body.statusMessage; }

    if (fields.length === 0) return { success: false, error: 'Nenhum campo para atualizar' };

    fields.push('DateModified = GETDATE()');

    await this.db.query(`UPDATE tbNFSe SET ${fields.join(', ')} WHERE ID = :id`, { replacements, type: QueryTypes.UPDATE });
    return { success: true };
  }

  /** Issue (emit) NFS-e — sends to SEFAZ via NFS-e Nacional API */
  @Post(':id/issue')
  async issue(@Param('id') id: string) {
    const [nfse] = await this.db.query('SELECT * FROM tbNFSe WHERE ID = :id', { replacements: { id: parseInt(id, 10) }, type: QueryTypes.SELECT }) as any[];
    if (!nfse) return { success: false, error: 'NFS-e não encontrada' };
    if (nfse.Status !== 1) return { success: false, error: 'NFS-e não está em rascunho' };

    // Get config
    const configs = await this.db.query('SELECT ConfigKey, ConfigValue FROM tbNFSeConfig', { type: QueryTypes.SELECT }) as any[];
    const cfg = Object.fromEntries(configs.map((c: any) => [c.ConfigKey, c.ConfigValue]));

    const environment = (cfg.Environment || 'homologacao') as 'homologacao' | 'producao';

    if (!cfg.CertificatePath) {
      await this.db.query(`
        UPDATE tbNFSe SET Status = 5, StatusMessage = 'Certificado digital e-CNPJ não configurado. Configure em ControleWeb > NFS-e > Configurações.',
        DateModified = GETDATE() WHERE ID = :id
      `, { replacements: { id: parseInt(id, 10) }, type: QueryTypes.UPDATE });

      return {
        success: false,
        error: 'Certificado digital e-CNPJ não configurado. Configure nas configurações de NFS-e.',
        requiresCertificate: true,
      };
    }

    // Initialize the NFS-e Nacional service
    const { NFSeNacionalService } = await import('../../infrastructure/nfse/NFSeNacionalService');
    const nfseService = new NFSeNacionalService({
      cnpj: cfg.CNPJ || '12344385000193',
      inscricaoMunicipal: cfg.InscricaoMunicipal || '',
      razaoSocial: cfg.RazaoSocial || 'HIPNOTICUS TERAPIA LTDA',
      nomeFantasia: cfg.NomeFantasia || 'Hipnoticus',
      codigoMunicipio: cfg.CodigoMunicipio || '5300108',
      uf: cfg.UF || 'DF',
      serviceCode: cfg.ServiceCode || '8690-9/99',
      serviceDescription: cfg.ServiceDescription || 'Serviços de hipnoterapia clínica',
      issRate: parseFloat(cfg.ISSRate || '5.00'),
      environment,
      certPath: cfg.CertificatePath,
      certPassword: cfg.CertificatePassword || '',
    });

    // Emit the DPS
    const result = await nfseService.emitirDPS({
      prestadorCnpj: cfg.CNPJ || '12344385000193',
      prestadorIM: cfg.InscricaoMunicipal || '',
      tomadorCpfCnpj: nfse.TomadorCPFCNPJ,
      tomadorNome: nfse.TomadorName,
      tomadorEmail: nfse.TomadorEmail || undefined,
      codigoServico: nfse.ServiceCode || cfg.ServiceCode || '8690-9/99',
      descricaoServico: nfse.ServiceDescription,
      valorServico: parseFloat(nfse.Value),
      aliquotaISS: parseFloat(nfse.ISSRate),
      codigoMunicipio: cfg.CodigoMunicipio || '5300108',
    });

    if (result.success) {
      await this.db.query(`
        UPDATE tbNFSe SET Status = 2, Number = :number, VerificationCode = :code,
        Protocol = :protocol, PDFUrl = :pdfUrl,
        XMLRequest = :xmlReq, XMLResponse = :xmlRes,
        DateIssued = GETDATE(), DateModified = GETDATE(),
        StatusMessage = :msg
        WHERE ID = :id
      `, {
        replacements: {
          id: parseInt(id, 10),
          number: result.nfseNumber || '',
          code: result.chaveAcesso || '',
          protocol: result.protocol || '',
          pdfUrl: result.pdfUrl || '',
          xmlReq: result.xmlRequest || '',
          xmlRes: result.xmlResponse || '',
          msg: environment === 'producao' ? 'NFS-e emitida com sucesso via SEFAZ' : 'NFS-e emitida em ambiente de homologação',
        },
        type: QueryTypes.UPDATE,
      });

      logger.info(`NFS-e ${result.nfseNumber} issued for ID ${id} (${environment})`);
      return { success: true, number: result.nfseNumber, chaveAcesso: result.chaveAcesso, pdfUrl: result.pdfUrl, environment };
    } else {
      await this.db.query(`
        UPDATE tbNFSe SET Status = 5, StatusMessage = :msg,
        XMLRequest = :xmlReq, XMLResponse = :xmlRes,
        DateModified = GETDATE() WHERE ID = :id
      `, {
        replacements: {
          id: parseInt(id, 10),
          msg: result.error || 'Erro na emissão',
          xmlReq: result.xmlRequest || '',
          xmlRes: result.xmlResponse || '',
        },
        type: QueryTypes.UPDATE,
      });

      return { success: false, error: result.error };
    }
      type: QueryTypes.UPDATE,
    });

    logger.info(`NFS-e ${nfseNumber} issued for ID ${id} (${environment})`);
    return { success: true, number: nfseNumber, verificationCode, environment };
  }

  /** Cancel NFS-e */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    const [nfse] = await this.db.query('SELECT * FROM tbNFSe WHERE ID = :id', { replacements: { id: parseInt(id, 10) }, type: QueryTypes.SELECT }) as any[];
    if (!nfse) return { success: false, error: 'NFS-e não encontrada' };
    if (nfse.Status !== 2) return { success: false, error: 'Apenas NFS-e emitidas podem ser canceladas' };

    // TODO: Send cancellation to SEFAZ
    await this.db.query(`
      UPDATE tbNFSe SET Status = 3, DateCanceled = GETDATE(), DateModified = GETDATE(),
      StatusMessage = :msg WHERE ID = :id
    `, {
      replacements: { id: parseInt(id, 10), msg: body.reason || 'Cancelada pelo usuário' },
      type: QueryTypes.UPDATE,
    });

    logger.info(`NFS-e ID ${id} canceled`);
    return { success: true };
  }

  /** Get NFS-e configuration */
  @Get('config/all')
  async getConfig() {
    const configs = await this.db.query('SELECT * FROM tbNFSeConfig ORDER BY ID', { type: QueryTypes.SELECT });
    return configs;
  }

  /** Update NFS-e configuration */
  @Put('config/:key')
  async updateConfig(@Param('key') key: string, @Body() body: { value: string }) {
    await this.db.query(
      'UPDATE tbNFSeConfig SET ConfigValue = :value, DateModified = GETDATE() WHERE ConfigKey = :key',
      { replacements: { key, value: body.value }, type: QueryTypes.UPDATE }
    );
    return { success: true };
  }
}
