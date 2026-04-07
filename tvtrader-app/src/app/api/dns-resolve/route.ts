import { NextRequest, NextResponse } from 'next/server';
import dns from 'dns/promises';

/** Cache resolved hostname -> IPs with a 60s TTL */
const cache = new Map<string, { ips: string[]; expires: number }>();
const TTL = 60_000;

/**
 * POST /api/dns-resolve
 * Body: { hostnames: ["ddns.example.com", ...] }
 * Returns: { resolved: { "ddns.example.com": ["1.2.3.4"], ... } }
 */
export async function POST(request: NextRequest) {
  try {
    const { hostnames } = await request.json() as { hostnames?: string[] };
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return NextResponse.json({ resolved: {} });
    }

    const resolved: Record<string, string[]> = {};
    for (const hostname of hostnames.slice(0, 20)) {
      const cached = cache.get(hostname);
      if (cached && Date.now() < cached.expires) {
        resolved[hostname] = cached.ips;
        continue;
      }
      try {
        const addrs = await dns.resolve4(hostname);
        cache.set(hostname, { ips: addrs, expires: Date.now() + TTL });
        resolved[hostname] = addrs;
      } catch {
        resolved[hostname] = cached?.ips ?? [];
      }
    }

    return NextResponse.json({ resolved });
  } catch {
    return NextResponse.json({ resolved: {} });
  }
}
