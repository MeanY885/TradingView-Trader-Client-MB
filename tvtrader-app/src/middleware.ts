import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

interface WhitelistConfig {
  enabled: boolean;
  ips: string[];
}

let cachedConfig: WhitelistConfig | null = null;
let cacheExpiry = 0;

async function getConfig(): Promise<WhitelistConfig> {
  if (cachedConfig && Date.now() < cacheExpiry) return cachedConfig;
  try {
    const res = await fetch('http://localhost:2000/api/internal/ip-config', { cache: 'no-store' });
    if (res.ok) {
      cachedConfig = await res.json() as WhitelistConfig;
      cacheExpiry = Date.now() + 30_000;
    }
  } catch {}
  return cachedConfig ?? { enabled: true, ips: [] };
}

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | parseInt(octet, 10)) >>> 0, 0) >>> 0;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipToNum(ip) & mask) === (ipToNum(range) & mask);
}

function isAllowed(clientIp: string, ips: string[]): boolean {
  return ips.some((entry) => ipMatchesCidr(clientIp, entry));
}

export async function middleware(request: NextRequest) {
  // Emergency escape hatch — set DISABLE_IP_WHITELIST=true in .env to bypass allowlist
  if (process.env.DISABLE_IP_WHITELIST === 'true') return NextResponse.next();

  const config = await getConfig();
  if (!config.enabled) return NextResponse.next();

  // CF-Connecting-IP is the real visitor IP when traffic goes through Cloudflare
  const cfIp = request.headers.get('cf-connecting-ip');
  const forwarded = request.headers.get('x-forwarded-for');
  let clientIp = (
    cfIp
      ? cfIp
      : forwarded
        ? forwarded.split(',')[0]
        : request.headers.get('x-real-ip') ?? (request as unknown as { ip?: string }).ip ?? ''
  ).trim();

  // Normalise IPv6-mapped IPv4 (::ffff:192.168.1.1 → 192.168.1.1)
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
  // Treat IPv6 loopback as 127.0.0.1
  if (clientIp === '::1') clientIp = '127.0.0.1';

  // Always allow loopback regardless of allowlist — prevents localhost lockout
  if (clientIp === '127.0.0.1') return NextResponse.next();

  if (!clientIp || !isAllowed(clientIp, config.ips)) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:monospace;padding:2rem;background:#111;color:#eee">
        <h2>403 Forbidden</h2><p>Your IP (<code>${clientIp || 'unknown'}</code>) is not in the allowlist.</p>
      </body></html>`,
      { status: 403, headers: { 'Content-Type': 'text/html' } }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon|api/internal).*)',
  ],
};
