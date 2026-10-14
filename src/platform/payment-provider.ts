import { randomUUID } from 'node:crypto';
import { hmac, safeEqual } from './crypto.js';

export interface ChargeRequest { amount: string; currency: string; reference: string; customerRef: string }
export interface ChargeResult { id: string; status: 'succeeded' | 'pending' | 'failed'; reference: string; failureReason?: string }
export interface ProviderEvent { id: string; type: 'payment.succeeded' | 'payment.failed' | 'refund.created'; reference: string; amount?: string; currency?: string }

/**
 * Payment gateways are an interface only (the plan: add gateways when the business needs them). Two drivers exist:
 * `manual` (offline payments recorded by staff) and `mock` (deterministic, for tests/dev).
 */
export interface PaymentProvider {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /** Verifies the signature and returns the parsed event, or null if the signature is invalid. */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): ProviderEvent | null;
}

export class ManualProvider implements PaymentProvider {
  readonly name = 'manual';
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    return { id: `manual_${randomUUID()}`, status: 'pending', reference: req.reference };
  }
  verifyWebhook(): ProviderEvent | null {
    return null; // manual payments have no webhooks
  }
}

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  constructor(private readonly secret = 'mock-webhook-secret') {}
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const fail = req.customerRef.includes('fail');
    return { id: `mock_${randomUUID()}`, status: fail ? 'failed' : 'succeeded', reference: req.reference, ...(fail ? { failureReason: 'card_declined' } : {}) };
  }
  sign(rawBody: string): string {
    return hmac(this.secret, rawBody);
  }
  verifyWebhook(rawBody: string, signature: string | undefined): ProviderEvent | null {
    if (!signature || !safeEqual(this.sign(rawBody), signature)) return null;
    try {
      return JSON.parse(rawBody) as ProviderEvent;
    } catch {
      return null;
    }
  }
}

export function providerFor(name: string): PaymentProvider {
  if (name === 'mock') return new MockProvider();
  if (name === 'manual') return new ManualProvider();
  throw new Error(`Unknown payment provider "${name}"`);
}
