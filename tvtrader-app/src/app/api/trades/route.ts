import { NextResponse } from 'next/server';
import { query, getSettings } from '../../../lib/db';
import { convertToAccountCurrency } from '../../../lib/currency';
import { Trade } from '../../../types';

export async function GET() {
  try {
    const [result, settings] = await Promise.all([
      query<Trade>('SELECT * FROM trades ORDER BY created_at DESC LIMIT 100'),
      getSettings(),
    ]);
    const accountCurrency = settings.account_currency || 'GBP';

    // Enrich all trades with account-currency-converted peak/trough P/L.
    // For closed trades the rate is approximate (today's rate), but far more accurate
    // than the raw quote-currency value.
    const enriched = await Promise.all(
      result.rows.map(async (trade) => {
        const quoteCurrency = trade.instrument.split('_')[1];
        const entryNum = parseFloat(trade.entry_price);
        const absUnits = Math.abs(parseFloat(trade.units));
        const highestNum = trade.highest_price ? parseFloat(trade.highest_price) : null;
        const lowestNum = trade.lowest_price ? parseFloat(trade.lowest_price) : null;
        const peakRef = trade.direction === 'buy' ? highestNum : lowestNum;
        const troughRef = trade.direction === 'buy' ? lowestNum : highestNum;

        const [peakVal, troughVal] = await Promise.all([
          peakRef !== null
            ? convertToAccountCurrency(
                (trade.direction === 'buy' ? peakRef - entryNum : entryNum - peakRef) * absUnits,
                quoteCurrency, accountCurrency
              ).catch(() => null)
            : Promise.resolve(null),
          troughRef !== null
            ? convertToAccountCurrency(
                (trade.direction === 'buy' ? troughRef - entryNum : entryNum - troughRef) * absUnits,
                quoteCurrency, accountCurrency
              ).catch(() => null)
            : Promise.resolve(null),
        ]);

        return {
          ...trade,
          peak_pl: peakVal !== null ? peakVal.toFixed(2) : null,
          trough_pl: troughVal !== null ? troughVal.toFixed(2) : null,
        };
      })
    );

    return NextResponse.json({ trades: enriched });
  } catch (e) {
    console.error('Trades fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { id?: number; all?: boolean };
    if (body.all) {
      await query("DELETE FROM trades WHERE status != 'open'");
    } else if (body.id) {
      await query("DELETE FROM trades WHERE id = $1 AND status != 'open'", [body.id]);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('Trades delete error:', e);
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  }
}
