/**
 * Root proxy route for the IB Gateway login page.
 * Forwards to the gateway's root URL which serves the SSO login page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSettings } from '../../../lib/db';
import { ibGatewayFetch } from '../../../lib/brokers/interactive-brokers/gateway-fetch';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'https://localhost:5000';

export async function GET(request: NextRequest) {
  const settings = await getSettings();
  const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;

  try {
    const res = await ibGatewayFetch(gatewayUrl, {
      method: 'GET',
      redirect: 'manual',
    });

    const responseHeaders = new Headers();
    const forwardHeaders = ['content-type', 'set-cookie', 'location', 'cache-control'];
    for (const h of forwardHeaders) {
      const val = res.headers.get(h);
      if (val) responseHeaders.set(h, val);
    }

    // Handle redirects — gateway redirects to the SSO login page
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        let rewritten = location
          .replace(gatewayUrl, '/api/ib-gateway')
          .replace(/https:\/\/localhost:5000/g, '/api/ib-gateway');
        // Gateway returns relative paths like /sso/Login — prefix with /api/ib-gateway
        if (rewritten.startsWith('/') && !rewritten.startsWith('/api/ib-gateway')) {
          rewritten = '/api/ib-gateway' + rewritten;
        }
        responseHeaders.set('location', rewritten);
      }
      return new NextResponse(null, { status: res.status, headers: responseHeaders });
    }

    const body = await res.arrayBuffer();
    return new NextResponse(body, { status: res.status, headers: responseHeaders });
  } catch (e) {
    return NextResponse.json(
      { error: `IB Gateway not reachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const settings = await getSettings();
  const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;

  try {
    const body = await request.text().catch(() => undefined);
    const headers: Record<string, string> = {};
    const ct = request.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    const cookie = request.headers.get('cookie');
    if (cookie) headers['Cookie'] = cookie;

    const res = await ibGatewayFetch(gatewayUrl, {
      method: 'POST',
      headers,
      body: body || undefined,
    });

    const responseHeaders = new Headers();
    const forwardHeaders = ['content-type', 'set-cookie', 'location'];
    for (const h of forwardHeaders) {
      const val = res.headers.get(h);
      if (val) responseHeaders.set(h, val);
    }

    const responseBody = await res.arrayBuffer();
    return new NextResponse(responseBody, { status: res.status, headers: responseHeaders });
  } catch (e) {
    return NextResponse.json(
      { error: `IB Gateway not reachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
