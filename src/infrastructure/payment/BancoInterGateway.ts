/**
 * Banco Inter API — Boleto (Cobrança v3 "bolepix") + PIX Gateway
 *
 * Mirrors legacy GerarBoletoNovo() and PIX from PacotesContratar.aspx.cs
 * Uses OAuth2 client_credentials flow + REST API with mTLS.
 *
 * Endpoints:
 *   Sandbox:    https://cdpj-sandbox.partners.uatinter.co
 *   Production: https://cdpj.partners.bancointer.com.br
 *
 * Boletos use Cobrança v3 (/cobranca/v3/cobrancas). Inter retired v2 (/cobranca/v2/boletos), which now answers a
 * plain-text "404 page not found" (seen in Moses as {"raw":"404 page not found"}, 2026-11-20). In v3 the POST only
 * returns a codigoSolicitacao and the boleto + PIX are issued asynchronously, so createBoleto polls
 * GET /cobrancas/{codigoSolicitacao} until the barcode exists. Every later call (details, status, PDF, cancel) is by
 * codigoSolicitacao, so that is the identifier stored in tbOrders.Identifier and returned as `nossoNumero` (the name
 * Moses, the e-mails and the /boleto-pdf/:nossoNumero route already use). The bank's own nossoNumero is
 * `bankNossoNumero`.
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
  /** Cobrança v3 codigoSolicitacao: the identifier for every later call (kept under the historical name). */
  nossoNumero: string | null;
  /** The bank's nossoNumero printed on the boleto, when already issued. */
  bankNossoNumero?: string | null;
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

/** One HTTPS call: status code plus the parsed JSON body ({ raw } when the body is not JSON). */
export type InterTransport = (url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs?: number) => Promise<{ status: number; data: any }>;

export const COBRANCA_PATH = '/cobranca/v3/cobrancas';
/**
 * The devedor of an immediate Pix (cob): CPF (11 digits) or CNPJ (14), with the name. Without a usable document the
 * charge goes without devedor, which Inter accepts; a made-up one (00000000000) is refused as an invalid CPF.
 */
export function pixDevedor(name: string, doc: string): { devedor?: { nome: string; cpf?: string; cnpj?: string } } {
  const digits = String(doc || '').replace(/\D/g, '');
  const nome = String(name || '').trim().substring(0, 200);
  if (!nome || /^0+$/.test(digits)) return {};
  if (digits.length === 11) return { devedor: { cpf: digits, nome } };
  if (digits.length === 14) return { devedor: { cnpj: digits, nome } };
  return {};
}
/** When an immediate Pix stops being payable (calendario.criacao + expiracao), or null when unknown. */
export function pixExpiresAt(cob: any): Date | null {
  const created = Date.parse(String(cob?.calendario?.criacao || ''));
  const seconds = Number(cob?.calendario?.expiracao);
  return Number.isFinite(created) && Number.isFinite(seconds) ? new Date(created + seconds * 1000) : null;
}

/**
 * Public URL Banco Inter calls back (Cobrança v3 and PIX). It must be the API host: moses.hipnoticus.com.br only
 * serves the Angular app and answered every callback with 405 (2026-11-20), so payments were confirmed only by polling.
 */
export const DEFAULT_WEBHOOK_URL = 'https://api.hipnoticus.com.br/contract-service/payments/webhook/banco-inter';
export function webhookUrl(): string {
  return process.env.BANCO_INTER_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
}

/** Banco Inter refuses boletos under R$2.50. */
export const MIN_BOLETO_VALUE = 2.5;

/** v3 situacao values that mean the charge was paid (by boleto or by its PIX). */
const PAID_SITUACOES = new Set(['RECEBIDO', 'MARCADO_RECEBIDO']);
export function isCobrancaPaid(situacao: unknown): boolean {
  return PAID_SITUACOES.has(String(situacao || '').toUpperCase());
}

/** Flattens GET /cobranca/v3/cobrancas/{codigoSolicitacao} ({ cobranca, boleto, pix }). */
export function parseCobranca(d: any): {
  codigoSolicitacao: string | null; situacao: string; bankNossoNumero: string | null;
  linhaDigitavel: string | null; codigoBarras: string | null; pixCopiaECola: string | null; txid: string | null;
} {
  const c = d?.cobranca || {};
  return {
    codigoSolicitacao: c.codigoSolicitacao || d?.codigoSolicitacao || null,
    situacao: String(c.situacao || d?.situacao || '').toUpperCase(),
    bankNossoNumero: d?.boleto?.nossoNumero || null,
    linhaDigitavel: d?.boleto?.linhaDigitavel || null,
    codigoBarras: d?.boleto?.codigoBarras || null,
    pixCopiaECola: d?.pix?.pixCopiaECola || null,
    txid: d?.pix?.txid || null,
  };
}

/** Error text for a failed Inter response (title/detail/violacoes), never an empty string. */
export function interError(status: number, data: any): string {
  if (data && typeof data === 'object') {
    const v = Array.isArray(data.violacoes)
      ? data.violacoes.map((x: any) => [x?.propriedade, x?.razao].filter(Boolean).join(': ')).filter(Boolean).join('; ')
      : '';
    const msg = [data.title || data.message, data.detail, v].filter(Boolean).join(' - ');
    if (msg) return `Banco Inter ${status}: ${msg}`;
    if (typeof data.raw === 'string' && data.raw.trim()) return `Banco Inter ${status}: ${data.raw.trim().substring(0, 200)}`;
  }
  return `Banco Inter ${status}`;
}

/** POST /cobranca/v3/cobrancas body. seuNumero is limited to 15 characters by Inter. */
export function buildCobrancaBody(p: {
  customerName: string; customerCpf: string; amount: number; dueDate: string; seuNumero: string;
  customerEmail?: string; customerCep?: string;
}): any {
  const doc = String(p.customerCpf || '').replace(/\D/g, '');
  const email = String(p.customerEmail || '').trim();
  return {
    seuNumero: String(p.seuNumero).substring(0, 15),
    valorNominal: Math.round(Math.max(Number(p.amount) || 0, MIN_BOLETO_VALUE) * 100) / 100,
    dataVencimento: p.dueDate,
    numDiasAgenda: 30,
    pagador: {
      cpfCnpj: doc,
      tipoPessoa: doc.length === 14 ? 'JURIDICA' : 'FISICA',
      nome: String(p.customerName || '').substring(0, 100),
      endereco: 'N/A',
      numero: 'S/N',
      complemento: '',
      bairro: 'N/A',
      cidade: 'Brasilia',
      uf: 'DF',
      cep: String(p.customerCep || '70308200').replace(/\D/g, '').padEnd(8, '0').substring(0, 8),
      ...(email ? { email } : {}),
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
  };
}

export class BancoInterGateway {
  private baseUrl: string;
  private transport: InterTransport;
  private sleep: (ms: number) => Promise<void>;

  constructor(private config: BancoInterConfig, opts: { transport?: InterTransport; sleep?: (ms: number) => Promise<void> } = {}) {
    this.baseUrl = config.sandbox
      ? 'https://cdpj-sandbox.partners.uatinter.co'
      : 'https://cdpj.partners.bancointer.com.br';
    this.transport = opts.transport || ((u, m, h, b, ms) => this.mtlsCall(u, m, h, b, ms));
    this.sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  /** Make an HTTPS request with mTLS certificate */
  private async mtlsCall(url: string, method: string, headers: Record<string, string>, body?: string, timeoutMs = 15000): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers: body !== undefined ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } : headers,
        rejectUnauthorized: true,
        timeout: timeoutMs,
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
          const status = res.statusCode || 0;
          try { resolve({ status, data: JSON.parse(data) }); }
          catch { resolve({ status, data: { raw: data } }); }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout: ${method} ${url}`));
      });
      req.on('error', (e) => reject(e));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** Parsed body only (token and PIX calls). */
  private async mtlsRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<any> {
    return (await this.transport(url, method, headers, body)).data;
  }

  /** Headers for Cobrança calls; x-conta-corrente picks the account when the integration covers more than one. */
  private cobrancaHeaders(token: string, json = false): Record<string, string> {
    const h: Record<string, string> = { 'Authorization': `Bearer ${token}` };
    if (json) h['Content-Type'] = 'application/json';
    if (this.config.accountNumber) h['x-conta-corrente'] = this.config.accountNumber;
    return h;
  }

  private cobrancaUrl(codigoSolicitacao: string, suffix = ''): string {
    return `${this.baseUrl}${COBRANCA_PATH}/${encodeURIComponent(codigoSolicitacao)}${suffix}`;
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

  /**
   * Issues a boleto with PIX (Cobrança v3). POST returns { codigoSolicitacao }; the barcode and PIX appear once Inter
   * finishes issuing (usually a few seconds), so the details are polled for up to ~12 s. A charge still being issued
   * after that is returned as a success without barcode: the PDF route and the polling service work by
   * codigoSolicitacao and pick it up later.
   */
  async createBoleto(
    customerName: string,
    customerCpf: string,
    amount: number,
    dueDate: string, // YYYY-MM-DD
    orderId: string,
    customerEmail: string = '',
    customerCep: string = '70308200',
  ): Promise<BoletoResult> {
    const fail = (error: string): BoletoResult => ({
      success: false, nossoNumero: null, bankNossoNumero: null, linhaDigitavel: null, codigoBarras: null,
      pdfUrl: null, pixCopiaECola: null, pixTxid: null, error,
    });
    if (!this.config.certPath || !this.config.keyPath) {
      return fail('Banco Inter certificate not configured (BANCO_INTER_CERT_PATH + KEY_PATH)');
    }
    try {
      const token = await this.getToken('boleto-cobranca.read boleto-cobranca.write');
      const body = buildCobrancaBody({ customerName, customerCpf, amount, dueDate, seuNumero: orderId, customerEmail, customerCep });

      logger.info(`Creating boleto (cobranca v3): order=${orderId} amount=${body.valorNominal} due=${dueDate}`);

      // Inter's issuing POST can take long when the bank is busy (2026-11-27: 15 s timeouts while the boleto WAS
      // created): wait longer, and if it still times out, look the boleto up by seuNumero before reporting a failure.
      let status = 0; let data: any = null;
      try {
        ({ status, data } = await this.transport(
          `${this.baseUrl}${COBRANCA_PATH}`, 'POST', this.cobrancaHeaders(token, true), JSON.stringify(body), 30000,
        ));
      } catch (e) {
        logger.warn(`Boleto POST failed for ${body.seuNumero} (${(e as Error).message}); looking it up by seuNumero`);
      }
      if (!data?.codigoSolicitacao) {
        const found = await this.findBySeuNumero(body.seuNumero).catch(() => null);
        if (found) {
          logger.info(`Boleto ${body.seuNumero} found at Inter after a failed POST: ${found}`);
          status = 200; data = { codigoSolicitacao: found };
        } else if (!status) {
          return fail('Banco Inter não respondeu a tempo. Tente de novo em instantes.');
        }
      }
      logger.info(`Boleto response ${status}: ${JSON.stringify(data).substring(0, 500)}`);

      const codigoSolicitacao: string | null = data?.codigoSolicitacao || null;
      if (status < 200 || status >= 300 || !codigoSolicitacao) {
        return fail(interError(status, data));
      }

      let details = parseCobranca(null);
      for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) await this.sleep(1500);
        const raw = await this.getBoletoDetails(codigoSolicitacao);
        if (!raw) continue;
        details = parseCobranca(raw);
        if (details.situacao === 'FALHA_EMISSAO') {
          return fail(`Banco Inter não conseguiu emitir o boleto (codigoSolicitacao ${codigoSolicitacao}).`);
        }
        if (details.linhaDigitavel) break;
      }
      if (!details.linhaDigitavel) {
        logger.warn(`Boleto ${codigoSolicitacao} still being issued (situacao=${details.situacao || 'unknown'})`);
      }

      return {
        success: true,
        nossoNumero: codigoSolicitacao,
        bankNossoNumero: details.bankNossoNumero,
        linhaDigitavel: details.linhaDigitavel,
        codigoBarras: details.codigoBarras,
        pdfUrl: null,
        pixCopiaECola: details.pixCopiaECola,
        pixTxid: details.txid,
        error: null,
      };
    } catch (error) {
      logger.error(`Boleto error: ${(error as Error).message}`);
      return fail((error as Error).message);
    }
  }

  /**
   * The codigoSolicitacao of a boleto issued in the last two days with this seuNumero, or null. Used when the issuing
   * POST timed out or failed: Inter may have created the boleto anyway, and issuing another one would leave two.
   */
  async findBySeuNumero(seuNumero: string): Promise<string | null> {
    const token = await this.getToken('boleto-cobranca.read');
    const day = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const url = `${this.baseUrl}${COBRANCA_PATH}?dataInicial=${day(1)}&dataFinal=${day(-1)}&filtrarDataPor=EMISSAO&itensPorPagina=1000&paginaAtual=0`;
    const { status, data } = await this.transport(url, 'GET', this.cobrancaHeaders(token));
    if (status < 200 || status >= 300) return null;
    for (const c of data?.cobrancas || []) {
      const x = c?.cobranca || c;
      if (String(x?.seuNumero || '') === String(seuNumero) && x?.codigoSolicitacao && String(x?.situacao).toUpperCase() !== 'CANCELADO') {
        return String(x.codigoSolicitacao);
      }
    }
    return null;
  }

  /**
   * Fetch full boleto details from Banco Inter API.
   * GET /cobranca/v3/cobrancas/{codigoSolicitacao} → { cobranca: { situacao, ... }, boleto: { nossoNumero,
   * linhaDigitavel, codigoBarras }, pix: { txid, pixCopiaECola } }. Null when the call fails.
   */
  async getBoletoDetails(codigoSolicitacao: string): Promise<any | null> {
    try {
      const token = await this.getToken('boleto-cobranca.read');
      const { status, data } = await this.transport(this.cobrancaUrl(codigoSolicitacao), 'GET', this.cobrancaHeaders(token));
      logger.info(`Boleto details for ${codigoSolicitacao} (${status}): ${JSON.stringify(data).substring(0, 300)}`);
      return status >= 200 && status < 300 ? data : null;
    } catch (error) {
      logger.error(`getBoletoDetails error: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if a boleto has been paid (by barcode or by its PIX).
   * v3 situacao values: A_RECEBER, ATRASADO, RECEBIDO, MARCADO_RECEBIDO, CANCELADO, EXPIRADO, FALHA_EMISSAO,
   * EM_PROCESSAMENTO, PROTESTO.
   */
  async checkBoletoStatus(codigoSolicitacao: string): Promise<{ paid: boolean; situacao: string }> {
    try {
      const details = await this.getBoletoDetails(codigoSolicitacao);
      if (!details) return { paid: false, situacao: 'UNKNOWN' };
      const { situacao } = parseCobranca(details);
      return { paid: isCobrancaPaid(situacao), situacao };
    } catch (error) {
      logger.error(`checkBoletoStatus error for ${codigoSolicitacao}: ${(error as Error).message}`);
      return { paid: false, situacao: 'ERROR' };
    }
  }

  /**
   * Fetch boleto PDF (base64) from Banco Inter API.
   * GET /cobranca/v3/cobrancas/{codigoSolicitacao}/pdf → { pdf: "base64" }
   */
  async getBoletoPdf(codigoSolicitacao: string): Promise<string | null> {
    try {
      const token = await this.getToken('boleto-cobranca.read');
      const { status, data } = await this.transport(this.cobrancaUrl(codigoSolicitacao, '/pdf'), 'GET', this.cobrancaHeaders(token));
      if (status === 200 && typeof data?.pdf === 'string' && data.pdf) return data.pdf;
      logger.warn(`Boleto PDF request returned ${status} for ${codigoSolicitacao}: ${JSON.stringify(data).substring(0, 200)}`);
      return null;
    } catch (error) {
      logger.error(`getBoletoPdf error: ${(error as Error).message}`);
      return null;
    }
  }

  /** POST /cobranca/v3/cobrancas/{codigoSolicitacao}/cancelar (Inter answers 202). */
  async cancelBoleto(codigoSolicitacao: string, motivoCancelamento = 'Cancelado pelo beneficiário'): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getToken('boleto-cobranca.read boleto-cobranca.write');
      const { status, data } = await this.transport(
        this.cobrancaUrl(codigoSolicitacao, '/cancelar'), 'POST', this.cobrancaHeaders(token, true),
        JSON.stringify({ motivoCancelamento: motivoCancelamento.substring(0, 50) }),
      );
      logger.info(`Cancel boleto ${codigoSolicitacao}: ${status}`);
      return status >= 200 && status < 300 ? { success: true } : { success: false, error: interError(status, data) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** The Pix key charges are paid to (the account's CNPJ by default). */
  get pixKey(): string {
    return this.config.pixKey || this.config.accountNumber;
  }

  /**
   * One call to Inter's Pix API (cob, cobr, rec, locrec) with a token for `scope`; Inter's own status and body come
   * back unchanged, a 4xx is an answer, not an exception. Retries once on 401 with a fresh token.
   */
  async pixApi(method: string, path: string, body: any, scope: string, retrying = false): Promise<{ status: number; data: any }> {
    const token = await this.getToken(scope);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json, application/problem+json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.config.accountNumber) headers['x-conta-corrente'] = this.config.accountNumber;
    const r = await this.transport(`${this.baseUrl}${path}`, method, headers, body === undefined ? undefined : JSON.stringify(body));
    if (r.status === 401 && !retrying) {
      delete this.accessTokens[scope];
      return this.pixApi(method, path, body, scope, true);
    }
    logger.info(`Pix API ${method} ${path.replace(/\?.*$/, '')} -> ${r.status}`);
    return r;
  }

  async createPixCobranca(
    customerName: string,
    customerCpf: string,
    amount: number,
    orderId: string,
    description: string = 'Hipnoticus - Solicitação de Agendamento',
    txid?: string,
    expiresIn = 86400, // 24 h by default: an expired charge shows as an invalid QR Code in the bank app
  ): Promise<PixCobrancaResult> {
    if (!this.config.certPath || !this.config.keyPath) {
      return { success: false, txid: null, pixCopiaECola: null, qrCodeBase64: null,
        error: 'Banco Inter certificate not configured (BANCO_INTER_CERT_PATH + KEY_PATH)' };
    }
    try {
      const token = await this.getToken();

      const body = {
        calendario: { expiracao: Math.round(Math.min(86400, Math.max(300, expiresIn))) },
        valor: { original: amount.toFixed(2) },
        chave: this.config.pixKey || this.config.accountNumber,
        solicitacaoPagador: description.substring(0, 140),
        ...pixDevedor(customerName, customerCpf),
        infoAdicionais: [
          { nome: 'Pedido', valor: orderId },
        ],
      };

      logger.info(`Creating PIX cobrança: order=${orderId} amount=${amount} chave=${this.config.pixKey || this.config.accountNumber}`);

      // With our own txid (PUT /cob/{txid}) the txid starts with the origin code, so the statement shows the origin.
      const data = await this.mtlsRequest(
        txid ? `${this.baseUrl}/pix/v2/cob/${encodeURIComponent(txid)}` : `${this.baseUrl}/pix/v2/cob`,
        txid ? 'PUT' : 'POST',
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
   * Check if a PIX cobrança has been paid.
   * GET /pix/v2/cob/{txid} — checks the status field.
   * Banco Inter status values: ATIVA, CONCLUIDA, REMOVIDA_PELO_USUARIO_RECEBEDOR, REMOVIDA_PELO_PSP
   */
  async checkPixStatus(txid: string): Promise<{ paid: boolean; status: string }> {
    try {
      const token = await this.getToken('cob.read');
      const data = await this.mtlsRequest(
        `${this.baseUrl}/pix/v2/cob/${txid}`,
        'GET',
        { 'Authorization': `Bearer ${token}` },
      );
      logger.info(`PIX status for txid=${txid}: ${JSON.stringify(data).substring(0, 300)}`);
      const status = (data.status || '').toUpperCase();
      return { paid: status === 'CONCLUIDA', status };
    } catch (error) {
      logger.error(`checkPixStatus error for ${txid}: ${(error as Error).message}`);
      return { paid: false, status: 'ERROR' };
    }
  }

  /**
   * Register a webhook URL with Banco Inter for boleto payment notifications.
   * PUT /cobranca/v3/cobrancas/webhook (204 No Content on success). Inter then POSTs an array of
   * { codigoSolicitacao, seuNumero, situacao, ... }; the callback only uses seuNumero to pick candidate orders.
   */
  async registerBoletoWebhook(webhookUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getToken('boleto-cobranca.write');
      logger.info(`Registering boleto webhook: ${webhookUrl}`);
      const { status, data } = await this.transport(
        `${this.baseUrl}${COBRANCA_PATH}/webhook`, 'PUT', this.cobrancaHeaders(token, true), JSON.stringify({ webhookUrl }),
      );
      logger.info(`Boleto webhook registration response ${status}: ${JSON.stringify(data).substring(0, 300)}`);
      return status >= 200 && status < 300 ? { success: true } : { success: false, error: interError(status, data) };
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
      // Explicit webhook scope: the code's default BANCO_INTER_SCOPE has none (production's env does). Inter posts
      // PIX callbacks to {webhookUrl}/pix (BCB API Pix), handled by POST /payments/webhook/banco-inter/pix.
      const token = await this.getToken('webhook.read webhook.write');
      const chave = this.config.pixKey || this.config.accountNumber;
      logger.info(`Registering PIX webhook for chave=${chave}: ${webhookUrl}`);
      const { status, data } = await this.transport(
        `${this.baseUrl}/pix/v2/webhook/${encodeURIComponent(chave)}`,
        'PUT',
        { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        JSON.stringify({ webhookUrl }),
      );
      logger.info(`PIX webhook registration response ${status}: ${JSON.stringify(data).substring(0, 300)}`);
      return status >= 200 && status < 300 ? { success: true } : { success: false, error: interError(status, data) };
    } catch (error) {
      logger.error(`PIX webhook registration error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
