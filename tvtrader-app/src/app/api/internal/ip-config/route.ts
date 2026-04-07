import { NextResponse } from 'next/server';
import { getSettings } from '../../../../lib/db';
import dns from 'dns/promises';

/** Cache resolved hostname → IPs with a 60s TTL */
const dnsCache = new Map<string, { ips: string[]; expires: number }>();
const DNS_TTL_MS = 60_000;

function isHostname(entry: string): boolean {
  // Not an IP or CIDR — contains letters and at least one dot
  return /[a-zA-Z]/.test(entry) && entry.includes('.');
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() < cached.expires) return cached.ips;

  try {
    const addresses = await dns.resolve4(hostname);
    dnsCache.set(hostname, { ips: addresses, expires: Date.now() + DNS_TTL_MS });
    return addresses;
  } catch (e) {
    console.warn(`[IP-CONFIG] DNS resolve failed for ${hostname}:`, e);
    // Return stale cache if available
    if (cached) return cached.ips;
    return [];
  }
}

export async function GET() {
  try {
    const settings = await getSettings();
    const enabled = settings.ip_whitelist_enabled === 'true';
    let entries: string[] = [];
    try { entries = JSON.parse(settings.ip_whitelist || '[]'); } catch {}

    // Separate IPs/CIDRs from hostnames, resolve hostnames to IPs
    const ips: string[] = [];
    const resolved: Record<string, string[]> = {};
    for (const entry of entries) {
      if (isHostname(entry)) {
        const addrs = await resolveHostname(entry);
        ips.push(...addrs);
        resolved[entry] = addrs;
      } else {
        ips.push(entry);
      }
    }

    return NextResponse.json({ enabled, ips, resolved });
  } catch {
    return NextResponse.json({ enabled: false, ips: [], resolved: {} });
  }
}

/** Exported for use by sibling API routes */
export { resolveHostname, isHostname };
