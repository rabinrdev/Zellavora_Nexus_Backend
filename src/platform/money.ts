import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';
const MODES: Record<RoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP, half_even: Decimal.ROUND_HALF_EVEN, down: Decimal.ROUND_DOWN, up: Decimal.ROUND_UP,
};

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND']);

/** Minor-unit exponent per ISO-4217 currency. */
export const currencyDecimals = (cur: string): number => (ZERO_DECIMAL.has(cur) ? 0 : THREE_DECIMAL.has(cur) ? 3 : 2);

export const D = (v: Decimal.Value): Decimal => new Decimal(v);

export function round(v: Decimal, currency: string, mode: RoundingMode = 'half_up'): Decimal {
  return v.toDecimalPlaces(currencyDecimals(currency), MODES[mode]);
}

export interface TaxSpec { rate: Decimal.Value; inclusive: boolean; compound: boolean }
export interface LineInput {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPct: Decimal.Value;
  taxes: TaxSpec[];
}
export interface LineResult { subtotal: Decimal; discount: Decimal; tax: Decimal; total: Decimal }

/**
 * Per-line computation, fully decimal. `subtotal` is the pre-tax amount after discount.
 * Inclusive taxes are extracted from the price; exclusive taxes are added; compound taxes apply on base + earlier taxes.
 */
export function computeLine(line: LineInput, currency: string, mode: RoundingMode = 'half_up'): LineResult {
  const gross = D(line.quantity).times(line.unitPrice);
  const discount = round(gross.times(line.discountPct).div(100), currency, mode);
  const net = gross.minus(discount);
  const inclRate = line.taxes.filter((t) => t.inclusive).reduce((a, t) => a.plus(D(t.rate)), D(0)).div(100);
  const baseRaw = net.div(D(1).plus(inclRate));
  const base = round(baseRaw, currency, mode);
  let tax = round(net.minus(baseRaw), currency, mode); // inclusive portion
  let running = D(0);
  const exclusive = [...line.taxes.filter((t) => !t.inclusive)].sort((a, b) => Number(a.compound) - Number(b.compound));
  for (const t of exclusive) {
    const b = t.compound ? base.plus(running) : base;
    const amount = round(b.times(t.rate).div(100), currency, mode);
    running = running.plus(amount);
    tax = tax.plus(amount);
  }
  // keep base + tax == net (inclusive) or net-derived total consistent after rounding
  const total = base.plus(tax);
  return { subtotal: base, discount, tax, total };
}

export function sumLines(lines: LineResult[], currency: string) {
  const z = D(0);
  const subtotal = lines.reduce((a, l) => a.plus(l.subtotal), z);
  const discount = lines.reduce((a, l) => a.plus(l.discount), z);
  const tax = lines.reduce((a, l) => a.plus(l.tax), z);
  const total = subtotal.plus(tax);
  const fix = (v: Decimal) => v.toFixed(currencyDecimals(currency));
  return { subtotal: fix(subtotal), discountTotal: fix(discount), taxTotal: fix(tax), total: fix(total) };
}

/** Parses client money input safely: rejects NaN, negatives, and more fractional digits than the currency allows. */
export function parseMoney(v: string | number, currency: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(v);
  } catch {
    throw new Error('Invalid amount');
  }
  if (!d.isFinite() || d.isNegative()) throw new Error('Amount must not be negative');
  if (d.decimalPlaces() > currencyDecimals(currency)) throw new Error(`At most ${currencyDecimals(currency)} decimal places`);
  return d;
}
