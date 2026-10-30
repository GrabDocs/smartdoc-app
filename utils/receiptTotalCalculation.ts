/**
 * Receipt total calculation driven by captured fields, not a fixed extras template.
 * Remainder is reconciliation only — never written back as a captured extra.
 */

export type ReceiptCalcLineItem = {
  quantity?: unknown;
  name?: unknown;
  price?: unknown;
  unit_price?: unknown;
  unitPrice?: unknown;
  line_total?: unknown;
  lineTotal?: unknown;
  amount?: unknown;
  total?: unknown;
  tax?: unknown;
  tax_amount?: unknown;
  taxAmount?: unknown;
  tax_included?: unknown;
  taxIncluded?: unknown;
  price_includes_tax?: unknown;
  qty?: unknown;
};

export type ReceiptCapturedExtra = {
  key: string;
  label: string;
  group: ExtraGroup;
  amount: number;
};

export type ExtraGroup =
  | 'tax'
  | 'tip'
  | 'discount'
  | 'refund'
  | 'fee'
  | 'deposit'
  | 'shipping'
  | 'service';

export type ReceiptCalcBreakdownRow = {
  label: string;
  amount: number;
};

export type ReceiptCalcResult = {
  itemsSubtotal: number;
  itemTax: number;
  extrasTotal: number;
  calculatedBeforeRemainder: number;
  remainder: number | null;
  displayTotal: number;
  rows: ReceiptCalcBreakdownRow[];
};

const MONEY_EPS = 0.005;

const EXTRA_ALLOWLIST: Array<{ group: ExtraGroup; label: string; subtractIfPositive: boolean; aliases: string[] }> = [
  { group: 'tax', label: 'Tax', subtractIfPositive: false, aliases: ['tax', 'tax_amount', 'taxamount', 'sales_tax', 'salestax', 'vat', 'gst', 'hst'] },
  { group: 'tip', label: 'Tip', subtractIfPositive: false, aliases: ['tip', 'tip_amount', 'tipamount', 'gratuity'] },
  { group: 'discount', label: 'Discount', subtractIfPositive: true, aliases: ['discount', 'discount_amount', 'discountamount', 'coupon', 'promo'] },
  { group: 'refund', label: 'Refund', subtractIfPositive: true, aliases: ['refund', 'refund_amount', 'refundamount', 'return'] },
  { group: 'fee', label: 'Fee', subtractIfPositive: false, aliases: ['fee', 'fees', 'service_fee', 'servicefee', 'processing_fee'] },
  { group: 'deposit', label: 'Deposit', subtractIfPositive: false, aliases: ['deposit', 'bottle_deposit', 'bottledeposit'] },
  { group: 'shipping', label: 'Shipping', subtractIfPositive: false, aliases: ['shipping', 'delivery', 'delivery_fee', 'deliveryfee', 'freight'] },
  { group: 'service', label: 'Service charge', subtractIfPositive: false, aliases: ['service_charge', 'servicecharge', 'svc_charge', 'svccharge'] },
];

const RATE_KEY = /rate|percent|pct|percentage/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function parseMoney(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed || trimmed === '-' || trimmed === '.') return 0;
    const n = parseFloat(trimmed.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function looksLikePercentageField(key: string, value: unknown): boolean {
  if (RATE_KEY.test(key)) return true;
  if (typeof value === 'string' && value.trim().endsWith('%')) return true;
  return false;
}

function signedExtraAmount(raw: number, subtractIfPositive: boolean): number {
  if (raw < 0) return raw;
  return subtractIfPositive ? -raw : raw;
}

export function parseQuantity(item: ReceiptCalcLineItem): number {
  const raw = item.quantity ?? item.qty;
  if (raw == null || raw === '') return 1;
  const n = parseMoney(raw);
  return n > 0 ? n : 1;
}

/** Line merchandise amount (no tax). Never counts unit×qty and extended amount together. */
export function lineMerchandiseAmount(item: ReceiptCalcLineItem): number {
  const qty = parseQuantity(item);
  const unit = item.unit_price ?? item.unitPrice;
  const extended = item.line_total ?? item.lineTotal;
  if (extended != null && extended !== '') return parseMoney(extended);
  if (unit != null && unit !== '') return qty * parseMoney(unit);
  const price = parseMoney(item.price ?? item.amount ?? item.total ?? 0);
  if (qty <= 1) return price;
  return qty * price;
}

function taxAlreadyInLineAmount(item: ReceiptCalcLineItem): boolean {
  return Boolean(item.tax_included || item.taxIncluded || item.price_includes_tax);
}

export function lineItemTax(item: ReceiptCalcLineItem, merchandise: number): number {
  const raw = item.tax_amount ?? item.taxAmount ?? item.tax;
  if (raw == null || raw === '') return 0;
  if (taxAlreadyInLineAmount(item)) return 0;
  const tax = parseMoney(raw);
  if (!tax) return 0;
  if (merchandise > 0 && Math.abs(tax - merchandise) < MONEY_EPS) return 0;
  return tax;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function sourceObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? flattenSource(parsed) : {};
    } catch {
      return {};
    }
  }
  if (!isPlainObject(raw)) return {};
  return flattenSource(raw);
}

function flattenSource(obj: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> = { ...obj };
  if (isPlainObject(out.json_data)) out = { ...out, ...out.json_data };
  if (isPlainObject(out.JSON)) out = { ...out, ...out.JSON };
  if (isPlainObject(out.receipt_data)) out = { ...out, ...out.receipt_data };
  if (isPlainObject(out.invoice_data)) out = { ...out, ...out.invoice_data };
  return out;
}

export function parseOptionalMoney(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  const n = parseMoney(v);
  return Number.isFinite(n) ? n : null;
}

export const RECEIPT_CALC_META = {
  printedTotal: 'printed_total',
  calculatedTotal: 'calculated_total',
  remainder: 'unclassified_remainder',
  autoCalculate: 'auto_calculate',
} as const;

export function printedTotalFromSource(raw: unknown): number | null {
  const src = sourceObject(raw);
  const captured = src.printed_total ?? src.printedTotal;
  if (captured != null && captured !== '') return parseOptionalMoney(captured);
  const rawTotal = src.total_amount ?? src.totalAmount ?? src.total ?? src.amount;
  if (rawTotal == null || rawTotal === '') return null;
  return parseOptionalMoney(rawTotal);
}

export function remainderFromSource(raw: unknown): number | null {
  const src = sourceObject(raw);
  const rawRemainder = src.unclassified_remainder ?? src.unclassifiedRemainder;
  if (rawRemainder == null || rawRemainder === '') return null;
  return parseOptionalMoney(rawRemainder);
}

export function autoCalculateFromSource(raw: unknown): boolean {
  const src = sourceObject(raw);
  return src.auto_calculate === true || src.auto_calculate === 'true';
}

export function lineItemsFromSource(raw: unknown): unknown[] {
  const src = sourceObject(raw);
  const items = src.items ?? src.line_items ?? src.lineItems;
  return Array.isArray(items) ? items : [];
}

export function discoverCapturedExtras(raw: unknown): ReceiptCapturedExtra[] {
  const src = sourceObject(raw);
  const extras: ReceiptCapturedExtra[] = [];

  for (const spec of EXTRA_ALLOWLIST) {
    let foundKey: string | null = null;
    let foundVal: unknown = undefined;
    for (const [key, value] of Object.entries(src)) {
      const nk = normalizeKey(key);
      if (!spec.aliases.includes(nk)) continue;
      if (looksLikePercentageField(key, value)) continue;
      if (value == null || value === '') continue;
      if (typeof value === 'object') continue;
      foundKey = key;
      foundVal = value;
      break;
    }
    if (!foundKey) continue;
    const amount = signedExtraAmount(parseMoney(foundVal), spec.subtractIfPositive);
    if (!amount) continue;
    extras.push({ key: foundKey, label: spec.label, group: spec.group, amount });
  }

  return extras;
}

export function extraClearPayload(
  originalSource: unknown,
  currentExtras: ReceiptCapturedExtra[]
): Record<string, string> {
  const keep = new Set(currentExtras.map((extra) => normalizeKey(extra.key)));
  const src = sourceObject(originalSource);
  const out: Record<string, string> = {};
  for (const spec of EXTRA_ALLOWLIST) {
    for (const key of Object.keys(src)) {
      const nk = normalizeKey(key);
      if (!spec.aliases.includes(nk)) continue;
      if (keep.has(nk)) continue;
      out[key] = '';
    }
  }
  return out;
}

export function editorLineToCalc(item: {
  quantity?: unknown;
  name?: unknown;
  price?: unknown;
  taxAmount?: unknown;
  useExtended?: boolean;
}): ReceiptCalcLineItem {
  return {
    quantity: item.quantity,
    name: item.name,
    price: item.price,
    line_total: item.useExtended ? item.price : undefined,
    tax_amount: item.taxAmount,
  };
}

function applicableExtras(extras: ReceiptCapturedExtra[], itemsHaveLineTax: boolean): ReceiptCapturedExtra[] {
  if (!itemsHaveLineTax) return extras;
  return extras.filter((extra) => extra.group !== 'tax');
}

export function computeReceiptTotal(input: {
  items: ReceiptCalcLineItem[];
  extras: ReceiptCapturedExtra[];
  printedTotal: number | null;
  includeRemainder: boolean;
  remainderOverride?: number | null;
}): ReceiptCalcResult {
  let itemsSubtotal = 0;
  let itemTax = 0;
  const rows: ReceiptCalcBreakdownRow[] = [];

  for (const item of input.items) {
    const merch = lineMerchandiseAmount(item);
    const tax = lineItemTax(item, merch);
    itemsSubtotal += merch;
    itemTax += tax;
  }
  if (itemsSubtotal) rows.push({ label: 'Items', amount: itemsSubtotal });
  if (itemTax) rows.push({ label: 'Item tax', amount: itemTax });

  const extras = applicableExtras(input.extras, itemTax > MONEY_EPS);
  let extrasTotal = 0;
  for (const extra of extras) {
    extrasTotal += extra.amount;
    rows.push({ label: extra.label, amount: extra.amount });
  }

  const calculatedBeforeRemainder = itemsSubtotal + itemTax + extrasTotal;
  let remainder: number | null = null;
  if (input.includeRemainder && input.printedTotal != null) {
    if (input.remainderOverride != null) {
      remainder = input.remainderOverride;
    } else {
      remainder = roundMoney(input.printedTotal - calculatedBeforeRemainder);
      if (Math.abs(remainder) < MONEY_EPS) remainder = 0;
    }
  }

  if (remainder != null && remainder !== 0) {
    rows.push({ label: 'Unclassified', amount: remainder });
  }

  const displayTotal = roundMoney(calculatedBeforeRemainder + (remainder || 0));
  return {
    itemsSubtotal: roundMoney(itemsSubtotal),
    itemTax: roundMoney(itemTax),
    extrasTotal: roundMoney(extrasTotal),
    calculatedBeforeRemainder: roundMoney(calculatedBeforeRemainder),
    remainder,
    displayTotal,
    rows,
  };
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function extrasToSavePayload(extras: ReceiptCapturedExtra[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const extra of extras) {
    out[extra.key] = extra.amount;
  }
  return out;
}
