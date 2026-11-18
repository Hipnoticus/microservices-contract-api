/**
 * Extra sections of the internal "Nova contratação" e-mail (tbConfig client.email.*data): "Dados enviados" (every
 * field the visitor submitted, plus IPs) and, for PIX, the QR code and the copia-e-cola string. Built in the layout of
 * the existing templates (hx-pad rows, same colours) and inserted before the "Pedido enviado em ... IP" footer row.
 */
import * as QRCode from 'qrcode';
import type { OrderSubmission, Submission } from './OrderSubmissions';

export const escapeHtml = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LABELS: Record<string, string> = {
  'customerId': 'ID do cliente',
  'customer.firstName': 'Nome', 'customer.lastName': 'Sobrenome', 'customer.cpf': 'CPF', 'customer.email': 'E-mail',
  'customer.phone': 'Telefone', 'customer.birthDate': 'Data de nascimento', 'customer.gender': 'Sexo',
  'customer.address.cep': 'CEP', 'customer.address.street': 'Endereço', 'customer.address.number': 'Número',
  'customer.address.complement': 'Complemento', 'customer.address.neighborhood': 'Bairro',
  'customer.address.city': 'Cidade', 'customer.address.state': 'UF', 'customer.address.country': 'País',
  'mainGoal': 'Objetivo prioritário', 'paymentMethodId': 'Forma de pagamento (ID)',
  'firstAppointmentDay': '1ª consulta: dia', 'firstAppointmentHour': '1ª consulta: horário',
  'sessionDay': 'Sessões: dia', 'sessionHour': 'Sessões: horário', 'total': 'Total enviado',
  'installments': 'Parcelas', 'packageId': 'Pacote (ID)', 'packageSize': 'Sessões do pacote',
  'orderId': 'Pedido', 'paymentMethodIdExt': 'Forma de pagamento', 'customerName': 'Nome',
  'customerCpf': 'CPF', 'customerEmail': 'E-mail', 'customerPhone': 'Telefone',
  'customerBirthDate': 'Data de nascimento', 'amount': 'Valor enviado', 'testMode': 'Modo teste',
  'address.cep': 'CEP', 'address.street': 'Endereço', 'address.number': 'Número', 'address.complement': 'Complemento',
  'address.neighborhood': 'Bairro', 'address.city': 'Cidade', 'address.state': 'UF',
  'card.number': 'Cartão: número', 'card.holder': 'Cartão: nome', 'card.expirationDate': 'Cartão: validade',
  'card.securityCode': 'Cartão: CVV', 'card.brand': 'Cartão: bandeira', 'saveCard': 'Salvar cartão',
  'savedCardId': 'Cartão salvo (ID)',
};

const MAX_FIELDS = 120;
const MAX_VALUE = 300;

/** Flattens a submitted JSON body into [path, display value], masking card data and secrets. */
export function flattenSubmitted(body: unknown, prefix = '', out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (out.length >= MAX_FIELDS) return out;
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && depth < 4) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (out.length >= MAX_FIELDS) break;
      flattenSubmitted(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return out;
  }
  let value: string;
  if (/(securitycode|cvv|cvc|password|senha|token)$/i.test(prefix)) value = body ? '(omitido)' : '';
  else if (/card\.number$/i.test(prefix)) {
    const d = String(body ?? '').replace(/\D/g, '');
    value = d ? `**** ${d.slice(-4)}` : '';
  } else if (body === null || body === undefined) value = '';
  else if (typeof body === 'object') value = JSON.stringify(body);
  else value = String(body);
  if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE) + '…';
  out.push([prefix || '(corpo)', value]);
  return out;
}

const ROW_LABEL = 'padding:8px 16px;color:#8a7d72;border-bottom:1px solid #f6eee9;vertical-align:top;';
const ROW_VALUE = 'padding:8px 16px;color:#1c1412;border-bottom:1px solid #f6eee9;word-break:break-all;';
const SECTION_TITLE = 'font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a8998e;font-weight:bold;margin-bottom:10px;';
const BOX = 'border:1px solid #f1e6df;border-radius:14px;font-size:13px;line-height:19px;';

function row(label: string, value: string, rawHtml = false): string {
  return `<tr><td width="40%" style="${ROW_LABEL}">${escapeHtml(label)}</td><td style="${ROW_VALUE}">${rawHtml ? value : escapeHtml(value) || '&mdash;'}</td></tr>`;
}

function group(title: string): string {
  return `<tr><td colspan="2" style="padding:10px 16px 6px;color:#bf311a;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;border-bottom:1px solid #f6eee9;">${escapeHtml(title)}</td></tr>`;
}

function submissionRows(title: string, s: Submission | undefined): string {
  if (!s) return group(title) + row('Dados', 'não disponíveis (o serviço reiniciou depois do envio)');
  let html = group(title);
  html += row('IP', s.ip);
  html += row('Navegador', s.userAgent);
  html += row('Recebido em', s.at.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
  for (const [k, v] of flattenSubmitted(s.body)) html += row(LABELS[k] ? `${LABELS[k]} (${k})` : k, v);
  return html;
}

/** "Dados enviados": the customer's birth date and IP always, then every field of both requests. */
export function submittedDataSection(sub: OrderSubmission, birthDate: string, clientIp: string): string {
  return `<tr><td class="hx-pad" style="padding:22px 40px 0;font-family:Helvetica,Arial,sans-serif;">`
    + `<div style="${SECTION_TITLE}">Dados enviados</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${BOX}">`
    + row('Data de nascimento', birthDate)
    + row('IP do cliente', clientIp)
    + submissionRows('Cadastro e pedido (POST /orders)', sub.order)
    + submissionRows('Pagamento (POST /payments/process)', sub.payment)
    + `</table></td></tr>`;
}

/**
 * The QR code as an HTML table (one table per module row, runs of equal modules merged). E-mail clients such as
 * Gmail drop data: images and EmailAPI sends no attachments, while a table renders everywhere.
 */
export function qrCodeHtml(payload: string, modulePx = 4): string {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  const total = size + quiet * 2;
  const rows: string[] = [];
  const line = (cells: Array<[boolean, number]>) => '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
    + 'style="border-collapse:collapse;font-size:0;line-height:0;"><tr>'
    + cells.map(([dark, n]) => `<td width="${n * modulePx}" height="${modulePx}" bgcolor="${dark ? '#000000' : '#ffffff'}"></td>`).join('')
    + '</tr></table>';
  for (let r = -quiet; r < size + quiet; r++) {
    const cells: Array<[boolean, number]> = [];
    for (let c = -quiet; c < size + quiet; c++) {
      const dark = r >= 0 && r < size && c >= 0 && c < size && !!qr.modules.get(r, c);
      const last = cells[cells.length - 1];
      if (last && last[0] === dark) last[1]++;
      else cells.push([dark, 1]);
    }
    rows.push(line(cells));
  }
  const px = total * modulePx;
  return `<div style="width:${px}px;background:#ffffff;font-size:0;line-height:0;">${rows.join('')}</div>`;
}

/** PIX section: QR code plus the copia-e-cola string. Empty when there is no PIX payload. */
export function pixSection(pixCopiaECola: string): string {
  const code = (pixCopiaECola || '').trim();
  if (!code) return '';
  let qr = '';
  try { qr = qrCodeHtml(code); } catch { qr = ''; }
  return `<tr><td class="hx-pad" style="padding:22px 40px 0;font-family:Helvetica,Arial,sans-serif;">`
    + `<div style="${SECTION_TITLE}">PIX</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${BOX}"><tr><td style="padding:16px;">`
    + (qr ? `<div style="font-size:12px;color:#8a7d72;margin-bottom:8px;">QR code</div>${qr}` : '')
    + `<div style="font-size:12px;color:#8a7d72;margin:14px 0 6px;">PIX copia e cola</div>`
    + `<div style="font-family:monospace;font-size:12px;line-height:18px;word-break:break-all;background:#f0fff4;border:1px solid #c6f6d5;border-radius:6px;padding:8px;color:#1c1412;">${escapeHtml(code)}</div>`
    + `</td></tr></table></td></tr>`;
}

/**
 * Inserts the sections before the template's footer row (the <tr> holding [IP_CLIENTE]); without that row they go
 * at the end, followed by an IP line so the IP is always present.
 */
export function insertBeforeFooter(template: string, sections: string, clientIp: string): string {
  if (!sections) return template;
  const ipAt = template.indexOf('[IP_CLIENTE]');
  if (ipAt >= 0) {
    const rowAt = template.lastIndexOf('<tr', ipAt);
    if (rowAt >= 0) return template.slice(0, rowAt) + sections + template.slice(rowAt);
  }
  const ipLine = `<tr><td class="hx-pad" style="padding:18px 40px 34px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;color:#a8998e;">IP ${escapeHtml(clientIp)}</td></tr>`;
  return template + sections + ipLine;
}
