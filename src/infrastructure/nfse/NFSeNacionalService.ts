/**
 * NFS-e Padrão Nacional — Integration with the Brazilian Government's
 * Ambiente de Dados Nacional (ADN) for electronic service invoices.
 *
 * API Documentation: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica
 * Endpoints:
 *   Homologação: https://adn.producaorestrita.nfse.gov.br/contribuintes/
 *   Produção:    https://adn.nfse.gov.br/contribuintes/
 *
 * Authentication: mTLS with e-CNPJ digital certificate (A1 or A3)
 * Format: REST/JSON (not SOAP — the national standard uses REST)
 */
import * as fs from 'fs';
import * as https from 'https';
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('NFSeNacional');

export interface NFSeConfig {
  cnpj: string;
  inscricaoMunicipal: string;
  razaoSocial: string;
  nomeFantasia: string;
  codigoMunicipio: string; // IBGE code (Brasília = 5300108)
  uf: string;
  serviceCode: string; // CNAE code
  serviceDescription: string;
  issRate: number;
  environment: 'homologacao' | 'producao';
  certPath: string; // PFX/P12 certificate path
  certPassword: string;
}

export interface DPSData {
  // Prestador (provider)
  prestadorCnpj: string;
  prestadorIM: string;
  // Tomador (customer)
  tomadorCpfCnpj: string;
  tomadorNome: string;
  tomadorEmail?: string;
  // Serviço
  codigoServico: string;
  descricaoServico: string;
  valorServico: number;
  aliquotaISS: number;
  // Município
  codigoMunicipio: string;
}

export class NFSeNacionalService {
  private baseUrl: string;
  private httpsAgent: https.Agent | null = null;

  constructor(private config: NFSeConfig) {
    this.baseUrl = config.environment === 'producao'
      ? 'https://adn.nfse.gov.br'
      : 'https://adn.producaorestrita.nfse.gov.br';

    this.initCertificate();
  }

  private initCertificate(): void {
    if (!this.config.certPath || !fs.existsSync(this.config.certPath)) {
      logger.warn('e-CNPJ certificate not found. NFS-e issuance will not work.');
      return;
    }

    try {
      const pfx = fs.readFileSync(this.config.certPath);
      this.httpsAgent = new https.Agent({
        pfx,
        passphrase: this.config.certPassword,
        rejectUnauthorized: true,
      });
      logger.info(`e-CNPJ certificate loaded from ${this.config.certPath} (${this.config.environment})`);
    } catch (err: any) {
      logger.error(`Failed to load e-CNPJ certificate: ${err.message}`);
    }
  }

  /**
   * Emit a DPS (Declaração de Prestação de Serviços) to generate an NFS-e.
   * This is the main method for issuing an electronic service invoice.
   */
  async emitirDPS(data: DPSData): Promise<{
    success: boolean;
    nfseNumber?: string;
    chaveAcesso?: string;
    protocol?: string;
    pdfUrl?: string;
    error?: string;
    xmlRequest?: string;
    xmlResponse?: string;
  }> {
    if (!this.httpsAgent) {
      return {
        success: false,
        error: 'Certificado digital e-CNPJ não configurado. Acesse ControleWeb > NFS-e > Configurações para configurar o certificado.',
      };
    }

    // Build the DPS payload following the NFS-e Nacional standard
    const dps = this.buildDPS(data);
    const dpsJson = JSON.stringify(dps);

    logger.info(`Emitting DPS for ${data.tomadorNome}, value R$ ${data.valorServico}`);

    try {
      const response = await this.sendRequest(
        '/contribuintes/dps',
        'POST',
        dps,
      );

      if (response.statusCode === 200 || response.statusCode === 201) {
        const result = response.body;
        logger.info(`NFS-e issued: ${result.chNFSe || result.numero || 'pending'}`);

        // Get the DANFSE (PDF) URL
        let pdfUrl = '';
        if (result.chNFSe) {
          pdfUrl = `${this.baseUrl.replace('adn', 'adn')}/danfse/${result.chNFSe}`;
        }

        return {
          success: true,
          nfseNumber: result.numero || result.nNFSe,
          chaveAcesso: result.chNFSe,
          protocol: result.nProt || result.protocolo,
          pdfUrl,
          xmlRequest: dpsJson,
          xmlResponse: JSON.stringify(result),
        };
      } else {
        const errorMsg = response.body?.mensagem || response.body?.message || JSON.stringify(response.body);
        logger.error(`NFS-e emission failed: HTTP ${response.statusCode} — ${errorMsg}`);
        return {
          success: false,
          error: `SEFAZ retornou erro ${response.statusCode}: ${errorMsg}`,
          xmlRequest: dpsJson,
          xmlResponse: JSON.stringify(response.body),
        };
      }
    } catch (err: any) {
      logger.error(`NFS-e emission error: ${err.message}`);
      return {
        success: false,
        error: `Erro de comunicação com SEFAZ: ${err.message}`,
        xmlRequest: dpsJson,
      };
    }
  }

  /**
   * Cancel an issued NFS-e.
   */
  async cancelar(chaveAcesso: string, motivo: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (!this.httpsAgent) {
      return { success: false, error: 'Certificado digital não configurado.' };
    }

    try {
      const response = await this.sendRequest(
        `/contribuintes/nfse/${chaveAcesso}/cancelar`,
        'POST',
        { motivo },
      );

      if (response.statusCode === 200) {
        logger.info(`NFS-e ${chaveAcesso} canceled`);
        return { success: true };
      } else {
        return {
          success: false,
          error: response.body?.mensagem || `Erro ${response.statusCode}`,
        };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Query an NFS-e by its access key.
   */
  async consultar(chaveAcesso: string): Promise<any> {
    if (!this.httpsAgent) return null;

    try {
      const response = await this.sendRequest(
        `/contribuintes/nfse/${chaveAcesso}`,
        'GET',
      );
      return response.body;
    } catch {
      return null;
    }
  }

  /**
   * Get the DANFSE (PDF) for an NFS-e.
   */
  getDanfseUrl(chaveAcesso: string): string {
    const danfseBase = this.config.environment === 'producao'
      ? 'https://adn.nfse.gov.br/danfse'
      : 'https://adn.producaorestrita.nfse.gov.br/danfse';
    return `${danfseBase}/${chaveAcesso}`;
  }

  /**
   * Build the DPS (Declaração de Prestação de Serviços) payload.
   * Follows the NFS-e Nacional JSON schema.
   */
  private buildDPS(data: DPSData): any {
    const now = new Date();
    const competencia = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const valorISS = Math.round(data.valorServico * data.aliquotaISS) / 100;

    return {
      infDPS: {
        tpAmb: this.config.environment === 'producao' ? 1 : 2,
        dhEmi: now.toISOString(),
        verAplic: 'Hipnoticus-1.0',
        serie: 'NFS',
        nDPS: Date.now().toString().slice(-8),
        dCompet: `${competencia}-01`,
        prest: {
          CNPJ: data.prestadorCnpj.replace(/\D/g, ''),
          IM: data.prestadorIM,
        },
        toma: {
          CPF: data.tomadorCpfCnpj.length <= 11 ? data.tomadorCpfCnpj.replace(/\D/g, '') : undefined,
          CNPJ: data.tomadorCpfCnpj.length > 11 ? data.tomadorCpfCnpj.replace(/\D/g, '') : undefined,
          xNome: data.tomadorNome,
          email: data.tomadorEmail,
        },
        serv: {
          cServ: {
            cTribNac: data.codigoServico.replace(/[^0-9]/g, ''),
          },
          xDescServ: data.descricaoServico,
          cMunPrestworking: data.codigoMunicipio,
        },
        valores: {
          vServPrest: {
            vServ: data.valorServico,
          },
          trib: {
            totTrib: {
              indTotTrib: 0,
            },
            issqn: {
              cMunGen: data.codigoMunicipio,
              aliq: data.aliquotaISS,
              vISSQN: valorISS,
            },
          },
        },
      },
    };
  }

  /**
   * Send an HTTPS request to the ADN API with mTLS.
   */
  private async sendRequest(
    path: string,
    method: string,
    body?: any,
  ): Promise<{ statusCode: number; body: any }> {
    const url = `${this.baseUrl}${path}`;

    const options: any = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };

    if (this.httpsAgent) {
      options.agent = this.httpsAgent;
    }

    const response = await fetch(url, {
      ...options,
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await response.json().catch(() => ({}));

    return {
      statusCode: response.status,
      body: responseBody,
    };
  }
}
