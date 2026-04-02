import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { syncTradeWithBroker } from '../../../../lib/trade-manager';
import { getBroker } from '../../../../lib/brokers/factory';
import { Trade } from '../../../../types';

async function backfillHighLow(trade: Trade): Promise<{ done: boolean }> {
  let highest: string | null = null;
  let lowest: string | null = null;
  let highestTime: string | null = null;
  let lowestTime: string | null = null;
  let source = '';

  const broker = await getBroker();

  try {
    const details = await broker.getTradeDetails(trade.broker_trade_id);
    if (details.highestPrice !== undefined && details.lowestPrice !== undefined) {
      highest = details.highestPrice.toString();
      lowest = details.lowestPrice.toString();
      source = 'broker_trade';
    }
  } catch { /* ignore */ }

  if (!highest || !lowest) {
    try {
      const closed = await broker.getClosedTrades(50);
      const found = closed.find((t) => t.brokerTradeId === trade.broker_trade_id);
      if (found?.highestPrice !== undefined && found?.lowestPrice !== undefined) {
        highest = found.highestPrice.toString();
        lowest = found.lowestPrice.toString();
        source = 'broker_closed_list';
      }
    } catch { /* ignore */ }
  }

  if ((!highest || !lowest) && trade.closed_at) {
    try {
      const from = new Date(trade.created_at).toISOString();
      const to = new Date(trade.closed_at).toISOString();
      const candles = await broker.getCandles(trade.instrument, from, to, 'M1');
      if (candles.length) {
        let maxH = -Infinity;
        let minL = Infinity;
        for (const candle of candles) {
          if (candle.midHigh > maxH) { maxH = candle.midHigh; highestTime = candle.time; }
          if (candle.midLow < minL) { minL = candle.midLow; lowestTime = candle.time; }
        }
        if (isFinite(maxH) && isFinite(minL)) {
          highest = maxH.toFixed(5);
          lowest = minL.toFixed(5);
          source = 'candles';
        }
      }
    } catch (e) {
      console.error(`H/L candle fallback failed for trade ${trade.id}:`, e);
    }
  }

  if (!highest || !lowest) return { done: false };

  try {
    await query(
      `UPDATE trades
       SET highest_price      = CASE WHEN $1::numeric > highest_price::numeric OR highest_price IS NULL THEN $1::text ELSE highest_price      END,
           highest_price_time = CASE WHEN $1::numeric > highest_price::numeric OR highest_price IS NULL THEN $3        ELSE highest_price_time END,
           lowest_price       = CASE WHEN $2::numeric < lowest_price::numeric  OR lowest_price  IS NULL THEN $2::text ELSE lowest_price       END,
           lowest_price_time  = CASE WHEN $2::numeric < lowest_price::numeric  OR lowest_price  IS NULL THEN $4        ELSE lowest_price_time  END
       WHERE id = $5`,
      [highest, lowest, highestTime, lowestTime, trade.id]
    );
    console.log(`[BACKFILL] Trade ${trade.id} H/L set from ${source}`);
    return { done: true };
  } catch (e) {
    console.error(`[BACKFILL] Failed to update H/L for trade ${trade.id}:`, e);
    return { done: false };
  }
}

export async function POST() {
  try {
    const openTrades = await query<Trade>("SELECT * FROM trades WHERE status = 'open'");
    const results: { id: number; synced: boolean }[] = [];

    for (const trade of openTrades.rows) {
      const synced = await syncTradeWithBroker(trade);
      results.push({ id: trade.id, synced });
    }

    const incomplete = await query<Trade>(
      "SELECT * FROM trades WHERE status != 'open' AND (realized_pl IS NULL OR close_price IS NULL OR highest_price IS NULL OR lowest_price IS NULL)"
    );

    for (const trade of incomplete.rows) {
      await backfillHighLow(trade);
    }

    return NextResponse.json({ success: true, synced: results });
  } catch (e) {
    console.error('Admin sync error:', e);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const incomplete = await query<Trade>(
      "SELECT * FROM trades WHERE status != 'open' AND (realized_pl IS NULL OR close_price IS NULL OR highest_price IS NULL OR lowest_price IS NULL) ORDER BY created_at DESC LIMIT 20"
    );
    return NextResponse.json({ trades: incomplete.rows });
  } catch (e) {
    console.error('Admin sync GET error:', e);
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 });
  }
}
