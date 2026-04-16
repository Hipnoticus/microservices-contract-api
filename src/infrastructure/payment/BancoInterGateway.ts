/**
 * Banco Inter API v2 — Boleto + PIX Gateway
 *
 * Mirrors legacy GerarBoletoNovo() and PIX from PacotesContratar.aspx.cs
 * Uses OAuth2 client_credentials flow + REST API.
 *
 * Endpoints:
 *   Sandbox:    https://cdpj-sandbox.partners.uatinter.co
 *   Production: https://cdpj.partners.bancointer.com.br
 */
import { Logger } from '../../shared/logger/Logger';
import * as fs from 'fs';
import * as https from 'https';

const logger = new Logger('BancoInterGateway');

export interface BancoInterConfig {
  clientId: string;
  clientSecret: string;
  certPath: string; // path to .crt certificate
  keyPath: string;  // path to .key private key
  accountNumber: string;
  pixKey: string;   // PIX key (CNPJ, CPF, email, phone, or random)
  scope: string;
  sandbox: boolean;
}

export interface BoletoResult {
  success: boolean;
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  codigoBarras: string | null;
  pdfUrl: string | null;
  // PIX associated with the boleto (Banco Inter hybrid boleto+PIX)
  pixCopiaECola: string | null;
  pixTxid: string | null;
  error: string | null;
}

export interface PixCobrancaResult {
  success: boolean;
  txid: string | null;
  pixCopiaECola: string | null;
  qrCodeBase64: string | null;
  error: string | null;
}

export class BancoInterGateway {
  private baseUrl: string;

  constructor(private config: BancoInterConfig) {
    this.baseUrl = config.sandbox
      ? 'https://cdpj-sandbox.partners.uatinter.co'
      : 'https://cdpj.partners.bancointer.com.br';
  }

  /** Make an HTTPS request with mTLS certificate */
  private async mtlsRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        rejectUnauthorized: true,
        timeout: 15000,
      };

      // mTLS: use cert + key files
      if (this.config.certPath && fs.existsSync(this.config.certPath)) {
        options.cert = fs.readFileSync(this.config.certPath);
      }
      if (this.config.keyPath && fs.existsSync(this.config.keyPath)) {
        options.key = fs.readFileSync(this.config.keyPath);
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data }); }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout: ${method} ${url}`));
      });
      req.on('error', (e) => reject(e));
      if (body) req.write(body);
      req.end();
    });
  }

  private accessTokens: Record<string, string> = {};
  private tokenExpiries: Record<string, number> = {};

  private async getToken(scopeOverride?: string): Promise<string> {
    const scope = scopeOverride || this.config.scope;
    const cacheKey = scope;

    if (this.accessTokens[cacheKey] && Date.now() < (this.tokenExpiries[cacheKey] || 0)) {
      return this.accessTokens[cacheKey];
    }

    logger.info(`Requesting Banco Inter OAuth2 token with scope: ${scope}`);

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope,
      grant_type: 'client_credentials',
    });

    try {
      const data = await this.mtlsRequest(
        `${this.baseUrl}/oauth/v2/token`,
        'POST',
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        params.toString(),
      );

      if (!data.access_token) {
        logger.error(`Banco Inter token failed: ${JSON.stringify(data)}`);
        throw new Error(`Token request failed: ${JSON.stringify(data)}`);
      }

      this.accessTokens[cacheKey] = data.access_token;
      this.tokenExpiries[cacheKey] = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
      logger.info('Banco Inter token acquired');
      return this.accessTokens[cacheKey];
    } catch (error) {
      logger.error(`Banco Inter token error: ${(error as Error).message}`);
      throw error;
    }
  }

  async createBoleto(
    customerName: string,
    customerCpf: string,
    amount: number,
    dueDate: string, // YYYY-MM-DD
    orderId: string,
    customerEmail: string = '',
    customerCep: string = '70308200',
  ): Promise<BoletoResult> {
    if (!this.config.certPath || !this.config.keyPath) {
      return { success: false, nossoNumero: null, linhaDigitavel: null, codigoBarras: null, pdfUrl: null,
        pixCopiaECola: null, pixTxid: null,
        error: 'Banco Inter certificate not configured (BANCO_INTER_CERT_PATH + KEY_PATH)' };
    }
    try {
      const token = await this.getToken();

      // Match legacy Boleto class structure (cobranca/v2/boletos)
      const dataEmissao = new Date().toISOString().split('T')[0];
      const dataLimite = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];

      // Banco Inter minimum boleto value is R$2.50
      const boletoAmount = Math.max(amount, 2.50);

      const body = {
        seuNumero: orderId,
        cnpjCPFBeneficiario: '12344385000193',
        valorNominal: boletoAmount.toFixed(2),
        dataEmissao,
        dataVencimento: dueDate,
        dataLimite,
        numDiasAgenda: 30,
        valorAbatimento: '0',
        pagador: {
          cpfCnpj: customerCpf.replace(/\D/g, ''),
          tipoPessoa: 'FISICA',
          nome: customerName,
          endereco: 'N/A',
          numero: 'S/N',
          complemento: '',
          bairro: 'N/A',
          cidade: 'Brasilia',
          uf: 'DF',
          cep: customerCep.replace(/\D/g, '').padEnd(8, '0').substring(0, 8),
          email: customerEmail,
          ddd: '61',
          telefone: '999999999',
        },
        mensagem: {
          linha1: 'Sr(a). CAIXA, após vencimento aceitar somente no Banco Inter.',
          linha2: 'Em dúvida, envie um e-mail para contato@hipnoterapia.org',
          linha3: 'Após pagamento, a compensação pode levar até 4 dias úteis.',
          linha4: '',
          linha5: '',
        },
        desconto1: { codigoDesconto: 'NAOTEMDESCONTO', taxa: 0, valor: 0 },
        desconto2: { codigoDesconto: 'NAOTEMDESCONTO', taxa: 0, valor: 0 },
        desconto3: { codigoDesconto: 'NAOTEMDESCONTO', taxa: 0, valor: 0 },
        multa: { codigoMulta: 'NAOTEMMULTA', taxa: 0, valor: 0 },
        mora: { codigoMora: 'ISENTO', taxa: 0, valor: 0 },
      };

      logger.info(`Creating boleto: order=${orderId} amount=${amount} due=${dueDate}`);

      const data = await this.mtlsRequest(
        `${this.baseUrl}/cobranca/v2/boletos`,
        'POST',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify(body),
      );

      logger.info(`Boleto response: ${JSON.stringify(data).substring(0, 500)}`);

      if (data.codigoSolicitacao || data.nossoNumero || data.linhaDigitavel) {
        const nossoNumero = data.nossoNumero || data.codigoSolicitacao;

        // Banco Inter POST /cobranca/v2/boletos typically returns only codigoSolicitacao.
        // We need GET /cobranca/v2/boletos/{nossoNumero} to get linhaDigitavel, codigoBarras, and PIX data.
        let linhaDigitavel = data.linhaDigitavel || null;
        let codigoBarras = data.codigoBarras || null;
        let pixCopiaECola = data.pix?.pixCopiaECola || data.pixCopiaECola || null;
        let pixTxid = data.pix?.txid || data.pixTxid || null;

        if (!linhaDigitavel && nossoNumero) {
          try {
            const details = await this.getBoletoDetails(nossoNumero);
            if (details) {
              linhaDigitavel = details.linhaDigitavel || linhaDigitavel;
              codigoBarras = details.codigoBarras || codigoBarras;
              pixCopiaECola = details.pix?.pixCopiaECola || details.pixCopiaECola || pixCopiaECola;
              pixTxid = details.pix?.txid || details.pixTxid || pixTxid;
            }
          } catch (e) {
            logger.warn(`Could not fetch boleto details for ${nossoNumero}: ${(e as Error).message}`);
          }
        }

        return {
          success: true,
          nossoNumero,
          linhaDigitavel,
          codigoBarras,
          pdfUrl: data.pdfUrl || null,
          pixCopiaECola,
          pixTxid,
          error: null,
        };
      }

      return {
        success: false, nossoNumero: null, linhaDigitavel: null,
        codigoBarras: null, pdfUrl: null, pixCopiaECola: null, pixTxid: null,
        error: data.message || data.title || JSON.stringify(data),
      };
    } catch (error) {
      logger.error(`Boleto error: ${(error as Error).message}`);
      return {
        success: false, nossoNumero: null, linhaDigitavel: null,
        codigoBarras: null, pdfUrl: null, pixCopiaECola: null, pixTxid: null,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Fetch full boleto details from Banco Inter API.
   * GET /cobranca/v2/boletos/{nossoNumero}
   * Returns linhaDigitavel, codigoBarras, PIX data, situacao, etc.
   */
  async getBoletoDetails(nossoNumero: string): Promise<any | null> {
    try {
      const token = await this.getToken('boleto-cobranca.read');
      const data = await this.mtlsRequest(
        `${this.baseUrl}/cobranca/v2/boletos/${nossoNumero}`,
        'GET',
        { 'Authorization': `Bearer ${token}` },
      );
      logger.info(`Boleto details for ${nossoNumero}: ${JSON.stringify(data).substring(0, 500)}`);
      return data;
    } catch (error) {
      logger.error(`getBoletoDetails error: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if a boleto has been paid.
   * Uses GET /cobranca/v2/boletos/{nossoNumero} and checks the situacao field.
   * Banco Inter situacao values: EMABERTO, PAGO, CANCELADO, EXPIRADO, VENCIDO
   */
  async checkBoletoStatus(nossoNumero: string): Promise<{ paid: boolean; situacao: string }> {
    try {
      const details = await this.getBoletoDetails(nossoNumero);
      if (!details) return { paid: false, situacao: 'UNKNOWN' };
      const situacao = (details.situacao || details.situacaoBoleto || '').toUpperCase();
      return { paid: situacao === 'PAGO', situacao };
    } catch (error) {
      logger.error(`checkBoletoStatus error for ${nossoNumero}: ${(error as Error).message}`);
      return { paid: false, situacao: 'ERROR' };
    }
  }

  /**
   * Fetch boleto PDF from Banco Inter API.
   * GET /cobranca/v2/boletos/{nossoNumero}/pdf
   */
  async getBoletoPdf(nossoNumero: string): Promise<string | null> {
    try {
      const token = await this.getToken('boleto-cobranca.read');
      const url = `${this.baseUrl}/cobranca/v2/boletos/${nossoNumero}/pdf`;

      const parsed = new URL(url);
      return new Promise((resolve) => {
        const options: https.RequestOptions = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
          rejectUnauthorized: true,
        };
        if (this.config.certPath && fs.existsSync(this.config.certPath)) {
          options.cert = fs.readFileSync(this.config.certPath);
        }
        if (this.config.keyPath && fs.existsSync(this.config.keyPath)) {
          options.key = fs.readFileSync(this.config.keyPath);
        }

        const req = https.request(options, (res) => {
          // Banco Inter returns the PDF as base64 in the body, or a redirect URL
          if (res.statusCode === 200) {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                // API returns { pdf: "base64string" }
                resolve(json.pdf || null);
              } catch {
                // If not JSON, it might be raw base64
                resolve(data || null);
              }
            });
          } else {
            logger.warn(`Boleto PDF request returned status ${res.statusCode} for nossoNumero=${nossoNumero}`);
            res.resume();
            resolve(null);
          }
        });
        req.on('error', (e) => {
          logger.error(`Boleto PDF error: ${e.message}`);
          resolve(null);
        });
        req.end();
      });
    } catch (error) {
      logger.error(`getBoletoPdf error: ${(error as Error).message}`);
      return null;
    }
  }

  async createPixCobranca(
    customerName: string,
    customerCpf: string,
    amount: number,
    orderId: string,
    description: string = 'Hipnoticus - Solicitação de Agendamento',
  ): Promise<PixCobrancaResult> {
    if (!this.config.certPath || !this.config.keyPath) {
      return { success: false, txid: null, pixCopiaECola: null, qrCodeBase64: null,
        error: 'Banco Inter certificate not configured (BANCO_INTER_CERT_PATH + KEY_PATH)' };
    }
    try {
      const token = await this.getToken();

      const body = {
        calendario: { expiracao: 3600 },
        valor: { original: amount.toFixed(2) },
        chave: this.config.pixKey || this.config.accountNumber,
        solicitacaoPagador: description,
        devedor: {
          cpf: customerCpf.replace(/\D/g, ''),
          nome: customerName,
        },
        infoAdicionais: [
          { nome: 'Pedido', valor: orderId },
        ],
      };

      logger.info(`Creating PIX cobrança: order=${orderId} amount=${amount} chave=${this.config.pixKey || this.config.accountNumber}`);

      const data = await this.mtlsRequest(
        `${this.baseUrl}/pix/v2/cob`,
        'POST',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify(body),
      );

      logger.info(`PIX response: ${JSON.stringify(data).substring(0, 500)}`);

      if (data.txid) {
        return {
          success: true,
          txid: data.txid,
          pixCopiaECola: data.pixCopiaECola || data.location || null,
          qrCodeBase64: null, // Would need a separate call to get QR image
          error: null,
        };
      }

      return {
        success: false, txid: null, pixCopiaECola: null, qrCodeBase64: null,
        error: data.message || data.title || JSON.stringify(data),
      };
    } catch (error) {
      logger.error(`PIX error: ${(error as Error).message}`);
      return {
        success: false, txid: null, pixCopiaECola: null, qrCodeBase64: null,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Register a webhook URL with Banco Inter for boleto payment notifications.
   * PUT /cobranca/v2/boletos/webhook
   */
  async registerBoletoWebhook(webhookUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getToken('boleto-cobranca.write');
      const body = { webhookUrl };
      logger.info(`Registering boleto webhook: ${webhookUrl}`);
      const data = await this.mtlsRequest(
        `${this.baseUrl}/cobranca/v2/boletos/webhook`,
        'PUT',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify(body),
      );
      logger.info(`Boleto webhook registration response: ${JSON.stringify(data).substring(0, 500)}`);
      // 204 No Content = success (data will be empty or { raw: '' })
      if (!data || data.raw === '' || !data.title) {
        return { success: true };
      }
      return { success: false, error: data.title || data.message || JSON.stringify(data) };
    } catch (error) {
      logger.error(`Boleto webhook registration error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Register a webhook URL with Banco Inter for PIX payment notifications.
   * PUT /pix/v2/webhook/{chave}
   */
  async registerPixWebhook(webhookUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getToken();
      const chave = this.config.pixKey || this.config.accountNumber;
      const body = { webhookUrl };
      logger.info(`Registering PIX webhook for chave=${chave}: ${webhookUrl}`);
      const data = await this.mtlsRequest(
        `${this.baseUrl}/pix/v2/webhook/${chave}`,
        'PUT',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify(body),
      );
      logger.info(`PIX webhook registration response: ${JSON.stringify(data).substring(0, 500)}`);
      if (!data || data.raw === '' || !data.title) {
        return { success: true };
      }
      return { success: false, error: data.title || data.message || JSON.stringify(data) };
    } catch (error) {
      logger.error(`PIX webhook registration error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
