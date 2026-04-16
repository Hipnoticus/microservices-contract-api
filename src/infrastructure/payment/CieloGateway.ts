/**
 * Cielo API 3.0 — Credit Card Payment Gateway
 *
 * Mirrors legacy PedidoProcessaCartaoCielo() from PacotesContratar.aspx.cs
 * Uses Cielo's REST API (not the old SOAP/SDK).
 *
 * Environments:
 *   Sandbox:    apiquerysandbox.cieloecommerce.cielo.com.br
 *   Production: api.cieloecommerce.cielo.com.br
 */
import { Logger } from '../../shared/logger/Logger';

const logger = new Logger('CieloGateway');

export interface CieloConfig {
  merchantId: string;
  merchantKey: string;
  sandbox: boolean;
}

export interface CieloCardData {
  cardNumber: string;
  holder: string;
  expirationDate: string; // MM/YYYY
  securityCode: string;
  brand: string; // Visa, Master, Elo, Amex, Diners
}

export interface CieloTransactionResult {
  success: boolean;
  paymentId: string | null;
  tid: string | null;
  authorizationCode: string | null;
  status: number;
  statusMessage: string;
  returnCode: string | null;
  returnMessage: string | null;
}

const CIELO_STATUS: Record<number, string> = {
  0: 'NotFinished', 1: 'Authorized', 2: 'PaymentConfirmed',
  3: 'Denied', 10: 'Voided', 11: 'Refunded', 12: 'Pending', 13: 'Aborted',
};

export class CieloGateway {
  private apiUrl: string;
  private queryUrl: string;

  constructor(private config: CieloConfig) {
    if (config.sandbox) {
      this.apiUrl = 'https://apisandbox.cieloecommerce.cielo.com.br';
      this.queryUrl = 'https://apiquerysandbox.cieloecommerce.cielo.com.br';
    } else {
      this.apiUrl = 'https://api.cieloecommerce.cielo.com.br';
      this.queryUrl = 'https://apiquery.cieloecommerce.cielo.com.br';
    }
  }

  async createTransaction(
    orderId: string,
    customerName: string,
    amount: number, // in BRL (e.g. 19990.00)
    installments: number,
    card: CieloCardData,
  ): Promise<CieloTransactionResult> {
    // Cielo expects amount in centavos
    const amountCentavos = Math.round(amount * 100);

    const body = {
      MerchantOrderId: orderId,
      Customer: { Name: customerName },
      Payment: {
        Type: 'CreditCard',
        Amount: amountCentavos,
        Installments: installments,
        SoftDescriptor: 'HIPNOTICUS',
        Capture: false,
        CreditCard: {
          CardNumber: card.cardNumber.replace(/\s/g, ''),
          Holder: card.holder,
          ExpirationDate: card.expirationDate,
          SecurityCode: card.securityCode,
          Brand: card.brand,
        },
      },
    };

    logger.info(`Cielo transaction: order=${orderId} amount=${amountCentavos} installments=${installments} brand=${card.brand}`);

    try {
      const res = await fetch(`${this.apiUrl}/1/sales/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MerchantId': this.config.merchantId,
          'MerchantKey': this.config.merchantKey,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as any;

      logger.info(`Cielo raw response: HTTP ${res.status} ${JSON.stringify(data).substring(0, 1000)}`);

      // Cielo returns errors as array [{Code, Message}] when auth fails
      if (Array.isArray(data)) {
        const errMsg = data.map((e: any) => `${e.Code}: ${e.Message}`).join('; ');
        return {
          success: false, paymentId: null, tid: null, authorizationCode: null,
          status: -1, statusMessage: 'CieloError',
          returnCode: data[0]?.Code?.toString() || null, returnMessage: errMsg,
        };
      }

      const payment = data?.Payment || {};
      const status = payment.Status ?? -1;

      const result: CieloTransactionResult = {
        success: status === 1 || status === 2, // Authorized or Confirmed
        paymentId: payment.PaymentId || null,
        tid: payment.Tid || null,
        authorizationCode: payment.AuthorizationCode || null,
        status,
        statusMessage: CIELO_STATUS[status] || 'Unknown',
        returnCode: payment.ReturnCode || null,
        returnMessage: payment.ReturnMessage || null,
      };

      logger.info(`Cielo result: status=${result.statusMessage} tid=${result.tid} auth=${result.authorizationCode} returnCode=${result.returnCode} returnMsg=${result.returnMessage}`);
      return result;
    } catch (error) {
      logger.error(`Cielo error: ${(error as Error).message}`);
      return {
        success: false, paymentId: null, tid: null, authorizationCode: null,
        status: -1, statusMessage: 'NetworkError',
        returnCode: null, returnMessage: (error as Error).message,
      };
    }
  }
}
