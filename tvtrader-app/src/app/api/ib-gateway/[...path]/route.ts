/**
 * Proxy route for the IB Client Portal Gateway.
 *
 * Forwards requests from the browser to the gateway, which runs on HTTPS
 * with a self-signed certificate inside Docker. This avoids mixed-content
 * and CORS issues when embedding the gateway login page in the settings UI.
 *
 * Paths:
 *   /api/ib-gateway/           → gateway login page (HTML)
 *   /api/ib-gateway/sso/...    → SSO auth endpoints
 *   /api/ib-gateway/v1/api/... → API endpoints
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSettings } from '../../../../lib/db';
import { ibGatewayFetch } from '../../../../lib/brokers/interactive-brokers/gateway-fetch';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'https://localhost:5000';

// Allowed path prefixes that we'll proxy to the gateway
const ALLOWED_PREFIXES = [
  '/sso/',
  '/v1/api/',
  '/portal/',
  '/portal.proxy/',
  '/proxy/',
  '/oauth/',
  '/ssodh/',
  '/tickle',
  // Static assets served by the gateway login page
  '/css/',
  '/scripts/',
  '/images/',
  '/lib/',
  '/en/',
  '/demo/',
  '/credential.recovery/',
];

function isAllowedPath(path: string): boolean {
  if (path === '' || path === '/') return true; // Root = login page
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function proxyRequest(request: NextRequest, method: string) {
  const settings = await getSettings();
  const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;

  // Extract the path after /api/ib-gateway/
  const url = new URL(request.url);
  const fullPath = url.pathname.replace('/api/ib-gateway', '') || '/';
  const queryString = url.search;

  if (!isAllowedPath(fullPath)) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  const targetUrl = `${gatewayUrl}${fullPath}${queryString}`;

  try {
    // Forward headers (strip host, add content-type)
    const headers: Record<string, string> = {};
    const contentType = request.headers.get('content-type');
    if (contentType) headers['Content-Type'] = contentType;

    // Forward cookies for session management
    const cookie = request.headers.get('cookie');
    if (cookie) headers['Cookie'] = cookie;

    const body = method !== 'GET' && method !== 'HEAD'
      ? await request.text().catch(() => undefined)
      : undefined;

    const res = await ibGatewayFetch(targetUrl, {
      method,
      headers,
      body: body || undefined,
      redirect: 'manual',
    });

    // Build response, forwarding status, headers, and body
    const responseHeaders = new Headers();

    // Forward relevant headers from gateway
    const forwardHeaders = ['content-type', 'set-cookie', 'location', 'cache-control'];
    for (const h of forwardHeaders) {
      const val = res.headers.get(h);
      if (val) responseHeaders.set(h, val);
    }

    // Rewrite Location headers for redirects
    const location = res.headers.get('location');
    if (location) {
      let rewritten = location.replace(gatewayUrl, '/api/ib-gateway');
      // Gateway returns relative paths like /sso/Login — prefix with /api/ib-gateway
      if (rewritten.startsWith('/') && !rewritten.startsWith('/api/ib-gateway')) {
        rewritten = '/api/ib-gateway' + rewritten;
      }
      responseHeaders.set('location', rewritten);
    }

    const responseBody = await res.arrayBuffer();

    // For HTML responses, rewrite internal URLs to go through our proxy
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      let html = new TextDecoder().decode(responseBody);
      // Rewrite gateway URLs in the HTML so links/forms go through our proxy
      html = html.replace(
        /https:\/\/localhost:5000/g,
        '/api/ib-gateway',
      );
      // Inject <base> tag so all relative URLs resolve through our proxy
      html = html.replace(
        '<head>',
        '<head><base href="/api/ib-gateway/">',
      );
      return new NextResponse(html, {
        status: res.status,
        headers: responseHeaders,
      });
    }

    // For CSS responses, rewrite url() references to absolute paths
    if (ct.includes('text/css')) {
      let css = new TextDecoder().decode(responseBody);
      css = css.replace(
        /url\(\s*['"]?\/(?!api\/ib-gateway)/g,
        "url('/api/ib-gateway/",
      );
      return new NextResponse(css, {
        status: res.status,
        headers: responseHeaders,
      });
    }

    return new NextResponse(responseBody, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Gateway unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return proxyRequest(request, 'GET');
}

export async function POST(request: NextRequest) {
  return proxyRequest(request, 'POST');
}

export async function PUT(request: NextRequest) {
  return proxyRequest(request, 'PUT');
}

export async function DELETE(request: NextRequest) {
  return proxyRequest(request, 'DELETE');
}
