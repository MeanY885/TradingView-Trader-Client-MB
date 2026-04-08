import { NextResponse } from 'next/server';
import { getSettings } from '../../../lib/db';
import { performAutoLogin } from '../../../lib/brokers/interactive-brokers/auto-login';
import { ibGatewayFetch } from '../../../lib/brokers/interactive-brokers/gateway-fetch';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'http://localhost:5000';

/**
 * POST /api/ib-auto-login
 *
 * Triggers an automated browser login to the IB Gateway using stored credentials.
 * Uses Puppeteer to navigate the SSO login page, enter credentials, and submit.
 * Automatically detects paper/live mode from the account ID.
 */
export async function POST() {
  try {
    const settings = await getSettings();
    const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;
    const username = settings.ib_username;
    const password = settings.ib_password;
    const accountId = settings.ib_account_id || '';

    if (!username || !password) {
      return NextResponse.json({
        success: false,
        message: 'IB username/password not configured. Set them in Settings → API Credentials.',
      }, { status: 400 });
    }

    // Check if already authenticated
    try {
      const statusRes = await ibGatewayFetch(`${gatewayUrl}/v1/api/iserver/auth/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json() as { authenticated?: boolean; connected?: boolean };
        if (statusData.authenticated && statusData.connected) {
          return NextResponse.json({ success: true, message: 'Already authenticated', skipped: true });
        }
      }
    } catch { /* gateway unreachable — proceed with login attempt */ }

    const result = await performAutoLogin(gatewayUrl, username, password, accountId);

    // If login succeeded, initialize accounts
    if (result.success) {
      try {
        await ibGatewayFetch(`${gatewayUrl}/v1/api/portfolio/accounts`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch { /* ignore — keepalive will handle this */ }
    }

    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({
      success: false,
      message: `Auto-login error: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 500 });
  }
}
