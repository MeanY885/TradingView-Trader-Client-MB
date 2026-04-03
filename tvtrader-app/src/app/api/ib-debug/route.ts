import { NextResponse } from 'next/server';
import { getBroker } from '../../../lib/brokers/factory';
import { INSTRUMENTS } from '../../../lib/brokers/instruments';

/**
 * Diagnostic endpoint — hit /api/ib-debug?instrument=EUR_USD to see
 * exactly what the IB Gateway returns for market data and positions.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const instrument = url.searchParams.get('instrument') || 'EUR_USD';

  const results: Record<string, unknown> = { instrument, timestamp: new Date().toISOString() };

  try {
    const broker = await getBroker();
    // @ts-expect-error — accessing internal client for diagnostics
    const client = broker.client || broker.getClient?.();

    if (!client) {
      return NextResponse.json({ error: 'No IB client available', broker: broker.brokerName });
    }

    const config = INSTRUMENTS[instrument];
    if (!config) {
      return NextResponse.json({ error: `Unknown instrument: ${instrument}` });
    }

    results.conid = config.ib.conid;

    // Test 1: Market data snapshot
    try {
      const snapshots = await client.getMarketDataSnapshot([config.ib.conid], ['31', '84', '86']);
      results.snapshot = snapshots;
    } catch (e) {
      results.snapshot_error = String(e);
    }

    // Test 2: Positions
    try {
      const positions = await client.getPositions();
      results.positions = positions;
    } catch (e) {
      results.positions_error = String(e);
    }

    // Test 3: getPricing (the full method)
    try {
      const pricing = await broker.getPricing(instrument);
      results.pricing = pricing;
    } catch (e) {
      results.pricing_error = String(e);
    }

    return NextResponse.json(results, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
