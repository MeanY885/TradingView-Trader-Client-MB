import { NextResponse } from 'next/server';
import tls from 'tls';
import { getSettings, updateSetting } from '../../../lib/db';

function tlsProbe(domain: string): Promise<{
  hasCert: boolean;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysUntilExpiry?: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert || !cert.valid_to) {
            resolve({ hasCert: false, error: 'No certificate returned' });
            return;
          }
          const validTo = new Date(cert.valid_to);
          const daysUntilExpiry = Math.floor((validTo.getTime() - Date.now()) / 86400000);
          const rawO = cert.issuer?.O;
          const rawCN = cert.issuer?.CN;
          const issuer = (Array.isArray(rawO) ? rawO[0] : rawO) ?? (Array.isArray(rawCN) ? rawCN[0] : rawCN) ?? 'Unknown';
          resolve({
            hasCert: true,
            issuer,
            validFrom: new Date(cert.valid_from).toISOString(),
            validTo: validTo.toISOString(),
            daysUntilExpiry,
          });
        } catch (e) {
          socket.destroy();
          resolve({ hasCert: false, error: String(e) });
        }
      }
    );
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve({ hasCert: false, error: 'Connection timed out' });
    });
    socket.on('error', (e) => {
      resolve({ hasCert: false, error: e.message });
    });
  });
}

function buildCaddyConfig(domain: string) {
  const appProxyHandler = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: 'app:2000' }],
    headers: {
      request: {
        set: {
          'X-Forwarded-For': ['{http.request.remote.host}'],
          'X-Real-IP': ['{http.request.remote.host}'],
        },
      },
    },
  };

  const gatewayProxyHandler = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: 'ib-gateway:5000' }],
  };

  // Gateway paths that don't overlap with app routes
  const gatewayPaths = [
    '/sso/*', '/ssodh/*', '/oauth/*', '/portal/*', '/portal.proxy/*',
    '/tickle', '/demo/*', '/credential.recovery/*',
    '/css/*', '/scripts/*', '/images/*', '/lib/*', '/en/*', '/fonts/*',
  ];

  // Route: gateway paths → ib-gateway, everything else → app
  const routes = [
    {
      match: [{ path: gatewayPaths }],
      handle: [gatewayProxyHandler],
    },
    {
      handle: [appProxyHandler],
    },
  ];

  return {
    apps: {
      http: {
        servers: {
          // HTTP — serves both app and gateway (no redirect, so IP access keeps working)
          http: {
            listen: [':80'],
            routes,
          },
          // HTTPS — serves both app and gateway for the configured domain with TLS
          https: {
            listen: [':443'],
            routes: [
              {
                match: [{ host: [domain], path: gatewayPaths }],
                handle: [gatewayProxyHandler],
              },
              {
                match: [{ host: [domain] }],
                handle: [appProxyHandler],
              },
            ],
          },
        },
      },
      tls: {
        automation: {
          policies: [
            {
              subjects: [domain],
              issuers: [{ module: 'acme' }],
            },
          ],
        },
      },
    },
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const domain = settings.webhook_domain?.trim();

    if (!domain) {
      return NextResponse.json({ configured: false });
    }

    const probe = await tlsProbe(domain);
    return NextResponse.json({ configured: true, domain, ...probe });
  } catch (e) {
    console.error('SSL status error:', e);
    return NextResponse.json({ error: 'Failed to check SSL status' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { domain } = (await request.json()) as { domain?: string };
    const trimmed = (domain ?? '').trim().toLowerCase();

    if (!trimmed) {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }
    if (trimmed.includes(' ') || trimmed.startsWith('http') || !trimmed.includes('.')) {
      return NextResponse.json(
        { error: 'Must be a plain hostname e.g. webhook.example.com' },
        { status: 400 }
      );
    }

    await updateSetting('webhook_domain', trimmed);

    // Push config to Caddy admin API (internal Docker network)
    const config = buildCaddyConfig(trimmed);
    try {
      const res = await fetch('http://caddy:2019/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://caddy:2019' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('Caddy config push failed:', text);
        return NextResponse.json(
          { ok: false, error: `Caddy rejected config: ${text}` },
          { status: 500 }
        );
      }
    } catch (e) {
      console.error('Could not reach Caddy admin API:', e);
      return NextResponse.json(
        { ok: false, error: 'Could not reach Caddy — is the caddy container running?' },
        { status: 503 }
      );
    }

    return NextResponse.json({ ok: true, domain: trimmed });
  } catch (e) {
    console.error('SSL setup error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
