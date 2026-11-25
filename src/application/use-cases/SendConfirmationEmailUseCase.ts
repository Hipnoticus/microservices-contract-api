import { callerHeaders } from '../../interfaces/http/auth/InternalAuth';
/**
 * SendConfirmationEmailUseCase — Sends confirmation emails after payment processing.
 *
 * Mirrors legacy EmailPreencheDados() from PacotesContratar.aspx.cs:
 *  - Loads HTML template from tbConfig by key
 *  - Replaces placeholders with order/customer data
 *  - Sends two emails: one to Hipnoticus (contato@hipnoterapia.org), one to the customer
 *
 * Template keys per payment method:
 *   Boleto:   client.email.boletodata / client.email.boletodata_cliente_success
 *   Card:     client.email.carddata / client.email.carddata_cliente_success
 *   Deposit:  client.email.depositodata / client.email.depositodata_cliente_success
 */
import { Logger } from '../../shared/logger/Logger';
import { properName } from '../../shared/names';
import type { OrderSubmission } from '../order/OrderSubmissions';
import { escapeHtml, insertBeforeFooter, pixSection, submittedDataSection } from '../order/InternalEmailSections';

const EXTRA_MARK = '\u0000HX_EXTRA_SECTIONS\u0000';

const logger = new Logger('SendConfirmationEmailUseCase');

export interface EmailContext {
  // Customer
  customerName: string;
  customerCpf: string;
  customerEmail: string;
  customerPhone: string;
  customerBirthDate: string;
  // Address
  addressCountry: string;
  addressCep: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressNeighborhood: string;
  addressCity: string;
  addressState: string;
  // Order
  mainGoal: string;
  packageSize: number;
  orderItems: string;
  firstAppointmentDay: string;
  firstAppointmentHour: string;
  sessionDay: string;
  sessionHour: string;
  // Payment
  paymentMethod: string; // 'cc-cielo' | 'inter-boleto' | 'deptransf' | 'pix'
  amount: number;
  installments: number;
  // Card-specific
  cardBrand?: string;
  cardNumber?: string;
  cardSecurityCode?: string;
  cardExpiration?: string;
  cardHolder?: string;
  transactionStatus?: string;
  // Boleto-specific
  boletoUrl?: string;
  boletoCodigoBarras?: string;
  boletoValue?: string;
  // PIX associated with boleto (for instant payment QR code)
  pixCopiaECola?: string;
  // Deposit-specific
  depositValue?: string;
  bankData?: string;
  // Client IP
  clientIp?: string;
  /** What the visitor sent (POST /orders and /payments/process); listed in the internal e-mail as "Dados enviados". */
  submitted?: OrderSubmission;
}

export class SendConfirmationEmailUseCase {
  constructor(
    private readonly sequelize: any,
    private readonly emailApiBaseUrl: string,
  ) {}

  async execute(ctx: EmailContext): Promise<void> {
    try {
      const templateKeys = this.getTemplateKeys(ctx.paymentMethod);
      if (!templateKeys) {
        logger.warn(`No email template keys for payment method: ${ctx.paymentMethod}`);
        return;
      }

      // Load templates from tbConfig
      const { QueryTypes } = require('sequelize');
      const keys = [templateKeys.hipnoticusKey, templateKeys.customerKey];
      const rows = await this.sequelize.query(
        `SELECT Name, Value FROM tbConfig WHERE Name IN (:keys)`,
        { replacements: { keys }, type: QueryTypes.SELECT },
      ) as any[];

      const templates: Record<string, string> = {};
      for (const r of rows) {
        if (r?.Name) templates[r.Name] = r.Value || '';
      }

      const hipnoticusTemplate = templates[templateKeys.hipnoticusKey] || '';
      const customerTemplate = templates[templateKeys.customerKey] || '';

      if (!hipnoticusTemplate && !customerTemplate) {
        logger.warn(`No email templates found for keys: ${keys.join(', ')}`);
        return;
      }

      // Replace placeholders
      const hipnoticusBody = this.replacePlaceholders(hipnoticusTemplate, ctx, true);
      const customerBody = this.replacePlaceholders(customerTemplate, ctx);

      // Send to Hipnoticus
      if (hipnoticusBody) {
        await this.sendEmail(
          'contato@hipnoterapia.org',
          'Hipnoticus',
          'contato@hipnoterapia.org',
          `Hipnoticus :: Dados ${ctx.customerName}`,
          hipnoticusBody,
        );
      }

      // Send to customer
      if (customerBody) {
        await this.sendEmail(
          'contato@hipnoterapia.org',
          ctx.customerName,
          ctx.customerEmail,
          'Hipnoticus :: Solicitação Concluída Com Sucesso!',
          customerBody,
        );
      }

      logger.info(`Confirmation emails sent for ${ctx.customerEmail} (method: ${ctx.paymentMethod})`);
    } catch (error) {
      logger.error(`Failed to send confirmation emails: ${(error as Error).message}`);
    }
  }

  private getTemplateKeys(method: string): { hipnoticusKey: string; customerKey: string } | null {
    switch (method) {
      case 'cc-cielo':
      case 'cc-stone':
        return { hipnoticusKey: 'client.email.carddata', customerKey: 'client.email.carddata_cliente_success' };
      case 'inter-boleto':
        return { hipnoticusKey: 'client.email.boletodata', customerKey: 'client.email.boletodata_cliente_success' };
      case 'deptransf':
      case 'pix':
      case 'pix-direto':
        return { hipnoticusKey: 'client.email.depositodata', customerKey: 'client.email.depositodata_cliente_success' };
      default:
        return null;
    }
  }

  private replacePlaceholders(template: string, ctx: EmailContext, internal = false): string {
    if (!template) return '';
    // Internal "Nova contratação" e-mail: "Dados enviados" and the PIX QR code go before the footer row. A marker is
    // placed first and filled last, so submitted values are never read as placeholders.
    if (internal) template = insertBeforeFooter(template, EXTRA_MARK, ctx.clientIp || '');

    const formatCurrency = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const installmentValue = ctx.installments > 0 ? ctx.amount / ctx.installments : ctx.amount;

    // Values typed by the visitor are HTML-escaped; template HTML (bank data, items, status) is not.
    // '$' too, because String.replace reads "$&" / "$'" in a replacement string as patterns.
    const esc = (v: unknown) => escapeHtml(v).replace(/\$/g, '&#36;');
    let result = template;

    // Customer data
    result = result.replace(/\[NOME_CLIENTE\]/g, esc(properName(ctx.customerName) || ctx.customerName));
    result = result.replace(/\[CPF_CLIENTE\]/g, esc(ctx.customerCpf));
    result = result.replace(/\[DATA_NASCIMENTO_CLIENTE\]/g, esc(ctx.customerBirthDate || ''));
    result = result.replace(/\[EMAIL_CLIENTE\]/g, esc(ctx.customerEmail));
    result = result.replace(/\[TELEFONE_CLIENTE\]/g, esc(ctx.customerPhone));

    // Address
    result = result.replace(/\[CLIENTE_ENDERECO_PAISES\]/g, esc(ctx.addressCountry || 'Brasil'));
    result = result.replace(/\[CLIENTE_ENDERECO_CEP\]/g, esc(ctx.addressCep || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_ENDERECO\]/g, esc(ctx.addressStreet || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_NUMERO\]/g, esc(ctx.addressNumber || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_COMPLEMENTO\]/g, esc(ctx.addressComplement || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_BAIRRO\]/g, esc(ctx.addressNeighborhood || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_CIDADE\]/g, esc(ctx.addressCity || ''));
    result = result.replace(/\[CLIENTE_ENDERECO_ESTADO\]/g, esc(ctx.addressState || ''));

    // Order
    result = result.replace(/\[CLIENTE_OBJETIVO_PRIORITARIO\]/g, esc(ctx.mainGoal || ''));
    result = result.replace(/\[CLIENTE_PEDIDO_ITENS\]/g, ctx.orderItems ||
      `<strong style="color: blue;">${ctx.packageSize} Sessões + [BÔNUS] Assinatura Vitalícia Hipno Online + [BÔNUS] Assinatura Vitalícia Sono Perfeito</strong>`);

    // Schedule
    result = result.replace(/\[CLIENTE_PRIMEIRACONSULTA_DIA\]/g, esc(ctx.firstAppointmentDay || ''));
    result = result.replace(/\[CLIENTE_PRIMEIRACONSULTA_HORA\]/g, esc(ctx.firstAppointmentHour || ''));
    result = result.replace(/\[CLIENTE_SESSAO_DIA\]/g, esc(ctx.sessionDay || ''));
    result = result.replace(/\[CLIENTE_SESSAO_HORA\]/g, esc(ctx.sessionHour || ''));

    // Card
    result = result.replace(/\[CLIENTE_CARTAO_BANDEIRA\]/g, esc(ctx.cardBrand || ''));
    result = result.replace(/\[CLIENTE_CARTAO_NUMERO\]/g, esc(ctx.cardNumber || ''));
    result = result.replace(/\[CLIENTE_CARTAO_COD_SEGURANCA\]/g, esc(ctx.cardSecurityCode || ''));
    result = result.replace(/\[CLIENTE_CARTAO_DATA_VENCIMENTO\]/g, esc(ctx.cardExpiration || ''));
    result = result.replace(/\[CLIENTE_CARTAO_NOME_NO_CARTAO\]/g, esc(ctx.cardHolder || ''));
    result = result.replace(/\[CLIENTE_CARTAO_PARCELAS\]/g, String(ctx.installments || 1));
    result = result.replace(/\[CLIENTE_CARTAO_VALOR\]/g,
      `${formatCurrency(ctx.amount)} em ${ctx.installments}x de ${formatCurrency(installmentValue)}`);

    // Boleto
    result = result.replace(/https:\/\/www\.hipnoterapia\.org\/\[CLIENTE_BOLETO_URL\]/g, ctx.boletoUrl || '');
    result = result.replace(/\[CLIENTE_BOLETO_URL\]/g, ctx.boletoUrl || '');
    result = result.replace(/\[CLIENTE_BOLETO_CODBARRAS\]/g, esc(ctx.boletoCodigoBarras || ''));
    result = result.replace(/\[CLIENTE_BOLETO_VALOR\]/g, ctx.boletoValue || `${formatCurrency(ctx.amount)} À VISTA`);

    // PIX (associated with boleto for instant payment)
    result = result.replace(/\[CLIENTE_PIX_COPIA_COLA\]/g, esc(ctx.pixCopiaECola || ''));
    // If template has a PIX section placeholder, inject the PIX block for boleto emails
    if (!internal && ctx.pixCopiaECola && ctx.paymentMethod === 'inter-boleto') {
      const pixBlock = `<br/><strong style="color: #2f855a;">⚡ Pagamento Instantâneo via PIX:</strong><br/>`
        + `<span style="font-family:monospace;font-size:11px;word-break:break-all;background:#f0fff4;padding:8px;display:inline-block;border:1px solid #c6f6d5;border-radius:4px;margin-top:4px;">`
        + `${ctx.pixCopiaECola}</span><br/><small style="color:#718096;">Copie o código acima e cole no app do seu banco para pagar instantaneamente.</small><br/>`;
      // Append PIX block after boleto barcode info if no explicit placeholder exists
      if (!result.includes('[CLIENTE_PIX_COPIA_COLA]')) {
        result = result.replace(/\[CLIENTE_BOLETO_CODBARRAS\]/g, ''); // already replaced above
        // Insert after the last boleto-related content
        const boletoUrlIdx = result.lastIndexOf(ctx.boletoCodigoBarras || '___no_match___');
        if (boletoUrlIdx > -1) {
          const insertAt = boletoUrlIdx + (ctx.boletoCodigoBarras || '').length;
          result = result.substring(0, insertAt) + pixBlock + result.substring(insertAt);
        } else {
          // Fallback: append before the transaction status
          result = result.replace('[CLIENTE_STATUS_TRANSACAO]', pixBlock + '[CLIENTE_STATUS_TRANSACAO]');
        }
      }
    }

    // Deposit
    result = result.replace(/\[CLIENTE_DEPOSITO_VALOR\]/g, ctx.depositValue || formatCurrency(ctx.amount));
    result = result.replace(/\[CLIENTE_DEPOSITO_VALOR_USD\]/g, (ctx.depositValue || formatCurrency(ctx.amount)).replace('R$', 'USD $'));
    result = result.replace(/\[CLIENTE_DEPOSITO_DADOS\]/g, ctx.bankData || '');

    // Transaction status & metadata
    result = result.replace(/\[CLIENTE_STATUS_TRANSACAO\]/g, ctx.transactionStatus || '<strong style="color: orange;">EFETUADA</strong>');
    result = result.replace(/\[IP_CLIENTE\]/g, esc(ctx.clientIp || ''));
    result = result.replace(/\[DATA_HORA_ENVIO\]/g, new Date().toLocaleString('pt-BR'));
    result = result.replace(/\[s\*o\*m\*a\]/g, '+');

    if (internal) {
      const extra = submittedDataSection(ctx.submitted || {}, ctx.customerBirthDate || '', ctx.clientIp || '')
        + pixSection(ctx.pixCopiaECola || '');
      result = result.split(EXTRA_MARK).join(extra);
    }

    return result;
  }

  private async sendEmail(from: string, toName: string, to: string, subject: string, content: string): Promise<void> {
    try {
      const response = await fetch(`${this.emailApiBaseUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // EmailAPI only lets service clients e-mail customers (EMAIL_API_CLIENT_TOKENS on its side)
          ...(process.env.EMAIL_API_TOKEN ? { 'X-Internal-Token': process.env.EMAIL_API_TOKEN } : {}),
          ...callerHeaders('contract-api'),
        },
        body: JSON.stringify({ from, fromName: 'Hipnoticus', to, toName, replyTo: from, subject, content }),
      });
      if (!response.ok) {
        logger.warn(`EmailAPI returned ${response.status} for ${to}`);
      }
    } catch (error) {
      logger.error(`Failed to call EmailAPI: ${(error as Error).message}`);
    }
  }
}
