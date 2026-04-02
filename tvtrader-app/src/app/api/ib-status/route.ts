import { NextResponse } from 'next/server';
import { getSettings } from '../../../lib/db';
import { ibGatewayFetch } from '../../../lib/brokers/interactive-brokers/gateway-fetch';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'https://localhost:5000';

export async function GET() {
  try {
    const settings = await getSettings();
    const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;

    const res = await ibGatewayFetch(`${gatewayUrl}/v1/api/iserver/auth/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      return NextResponse.json({
        authenticated: false,
        connected: false,
        message: `Gateway returned HTTP ${res.status}`,
      });
    }

    const data = await res.json() as {
      authenticated?: boolean;
      connected?: boolean;
      competing?: boolean;
      message?: string;
    };

    return NextResponse.json({
      authenticated: data.authenticated ?? false,
      connected: data.connected ?? false,
      competing: data.competing ?? false,
      message: data.message,
      gatewayUrl,
    });
  } catch (e) {
    return NextResponse.json({
      authenticated: false,
      connected: false,
      message: `Cannot reach gateway: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
