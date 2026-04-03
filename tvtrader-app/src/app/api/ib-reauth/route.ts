import { NextResponse } from 'next/server';
import { getSettings } from '../../../lib/db';
import { ibGatewayFetch } from '../../../lib/brokers/interactive-brokers/gateway-fetch';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'http://localhost:5000';

/**
 * POST /api/ib-reauth
 *
 * Attempts server-side re-authentication of the IB Gateway session.
 * Tries SSO validate → reauthenticate → auth status check.
 * Works when the session cookie is still valid but the brokerage connection dropped
 * (e.g. after daily maintenance). Does NOT work for completely new sessions.
 */
export async function POST() {
  try {
    const settings = await getSettings();
    const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;

    // Step 1: Check current status
    let status = await checkAuthStatus(gatewayUrl);
    if (status.authenticated && status.connected) {
      return NextResponse.json({ success: true, message: 'Already authenticated', status });
    }

    // Step 2: Try SSO validation
    try {
      await ibGatewayFetch(`${gatewayUrl}/v1/api/sso/validate`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch { /* ignore */ }

    await sleep(2000);
    status = await checkAuthStatus(gatewayUrl);
    if (status.authenticated && status.connected) {
      return NextResponse.json({ success: true, message: 'Re-authenticated via SSO validation', status });
    }

    // Step 3: Try reauthenticate endpoint
    try {
      await ibGatewayFetch(`${gatewayUrl}/v1/api/iserver/reauthenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch { /* ignore */ }

    await sleep(3000);
    status = await checkAuthStatus(gatewayUrl);
    if (status.authenticated && status.connected) {
      return NextResponse.json({ success: true, message: 'Re-authenticated via iserver/reauthenticate', status });
    }

    // Step 4: One more attempt with tickle + status
    try {
      await ibGatewayFetch(`${gatewayUrl}/v1/api/tickle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch { /* ignore */ }

    await sleep(2000);
    status = await checkAuthStatus(gatewayUrl);
    if (status.authenticated && status.connected) {
      return NextResponse.json({ success: true, message: 'Re-authenticated after tickle', status });
    }

    return NextResponse.json({
      success: false,
      message: 'Server-side re-auth failed. Manual login required.',
      status,
    });
  } catch (e) {
    return NextResponse.json({
      success: false,
      message: `Re-auth error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function checkAuthStatus(gatewayUrl: string) {
  try {
    const res = await ibGatewayFetch(`${gatewayUrl}/v1/api/iserver/auth/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { authenticated: false, connected: false };
    const data = await res.json() as { authenticated?: boolean; connected?: boolean; competing?: boolean };
    return {
      authenticated: data.authenticated ?? false,
      connected: data.connected ?? false,
      competing: data.competing ?? false,
    };
  } catch {
    return { authenticated: false, connected: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
