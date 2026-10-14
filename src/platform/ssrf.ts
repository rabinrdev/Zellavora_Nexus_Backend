import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? ipv4Private(mapped[1] as string) : false;
}

export interface SsrfOptions {
  requireHttps: boolean;
  resolver?: (host: string) => Promise<string[]>;
}

/** Validates an outbound URL: scheme, no credentials, and every resolved address must be public. */
export async function assertSafeOutboundUrl(raw: string, opts: SsrfOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !opts.requireHttps)) {
    throw new Error('URL scheme not allowed');
  }
  if (url.username || url.password) throw new Error('Credentials in URL not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const resolve =
    opts.resolver ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error('Destination address not allowed');
  return url;
}
