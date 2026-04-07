import { NextResponse } from 'next/server';
import { getCachedAdapter } from '../../../lib/brokers/factory';
import { IBAdapter } from '../../../lib/brokers/interactive-brokers/adapter';

/**
 * GET /api/ib-reauth-log
 *
 * Returns the in-memory re-authentication event log from the IB keepalive.
 */
export async function GET() {
  const adapter = getCachedAdapter();
  if (adapter && adapter instanceof IBAdapter) {
    return NextResponse.json({ events: adapter.getReauthLog() });
  }
  return NextResponse.json({ events: [] });
}
