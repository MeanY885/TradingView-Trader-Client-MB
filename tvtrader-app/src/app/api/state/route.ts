import { NextResponse } from 'next/server';
import { query, getSettings } from '../../../lib/db';
import { getBroker } from '../../../lib/brokers/factory';
import { convertToAccountCurrency, convertFromAccountCurrency } from '../../../lib/currency';
import { Trade } from '../../../types';

// 5-second cache for account summary — avoids duplicate broker calls when browser
// polls /api/account and /api/state simultaneously.
let _accountCache: { balance: number; ts: number } | null = null;
async function getCachedBalance(): Promise<number> {
  const now = Date.now();
  if (_accountCache && now - _accountCache.ts < 5000) return _accountCache.balance;
  const broker = await getBroker();
  const data = await broker.getAccountSummary().catch(() => null);
  const balance = data ? data.balance : 0;
  if (balance > 0) _accountCache = { balance, ts: now };
  return balance;
}

export async function GET() {
  try {
    const result = await query<Trade>(
      `SELECT * FROM trades WHERE status = 'open' ORDER BY created_at DESC`
    );

    if (result.rows.length === 0) {
      console.warn('[STATE] active:false — no open trades in DB');
      return NextResponse.json({ active: false, trades: [], trade: null });
    }

    const broker = await getBroker();
    const settings = await getSettings();
    const balance = await getCachedBalance();

    const enrichedTrades = await Promise.all(
      result.rows.map(async (trade) => {
        const [pricingData, brokerDetails] = await Promise.all([
          broker.getPricing(trade.instrument).catch(() => null),
          broker.getTradeDetails(trade.broker_trade_id).catch(() => null),
        ]);

        // If broker shows trade closed, the background poller will sync it within 2s.
        // For immediate UI consistency we also check here and exclude if already closed.
        const isClosed = brokerDetails?.state === 'CLOSED';
        if (isClosed) {
          const refreshed = await query<Trade>('SELECT * FROM trades WHERE id = $1', [trade.id]);
          if (refreshed.rows[0]?.status !== 'open') return null;
        }

        const enriched: Record<string, unknown> = { ...trade };

        // When broker market data is unavailable (e.g. paper account without subscriptions),
        // fall back to entry price so the dashboard isn't blank.
        if (!pricingData) {
          enriched.current_price = trade.entry_price;
        }

        if (pricingData) {
          const ask = pricingData.ask;
          const bid = pricingData.bid;
          const mid = (ask + bid) / 2;
          enriched.current_price = mid.toFixed(5);

          const highest = trade.highest_price ? parseFloat(trade.highest_price) : null;
          const lowest = trade.lowest_price ? parseFloat(trade.lowest_price) : null;
          const newHighest = highest === null || mid > highest ? mid : highest;
          const newLowest = lowest === null || mid < lowest ? mid : lowest;

          if (newHighest !== highest || newLowest !== lowest) {
            query(
              `UPDATE trades
               SET
                 highest_price      = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN $1::text ELSE highest_price END,
                 highest_price_time = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN NOW()    ELSE highest_price_time END,
                 lowest_price       = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN $2::text ELSE lowest_price END,
                 lowest_price_time  = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN NOW()   ELSE lowest_price_time END
               WHERE id = $3 AND status = 'open'`,
              [newHighest.toFixed(5), newLowest.toFixed(5), trade.id]
            ).catch(() => {});
            enriched.highest_price = newHighest.toFixed(5);
            enriched.lowest_price = newLowest.toFixed(5);
          }

          if (trade.spread_at_entry) {
            const spreadVal = parseFloat(trade.spread_at_entry);
            const absUnits = Math.abs(parseFloat(trade.units));
            enriched.spread_cost = (spreadVal * absUnits).toFixed(2);
          }
        }

        {
          // Compute P/L from price data when broker doesn't report it (e.g. broker_trade_id = -1)
          let pl = brokerDetails?.unrealizedPL ?? 0;
          if (pl === 0 && pricingData) {
            const mid = (pricingData.ask + pricingData.bid) / 2;
            const entry = parseFloat(trade.entry_price);
            const units = parseFloat(trade.units);
            const rawPL = (mid - entry) * units; // positive units = long, negative = short
            const quoteCcy = trade.instrument.split('_')[1];
            const acctCcy = settings.account_currency || 'GBP';
            pl = await convertToAccountCurrency(rawPL, quoteCcy, acctCcy);
          }
          enriched.current_pl = pl.toFixed(2);
          if (balance > 0) {
            enriched.current_pl_pct = (pl / balance * 100).toFixed(2);
          }

          // Profit/loss exit prices are computed here for the UI bar markers.
          // Actual exit logic runs in the background poller every 2 s.
          const accountCurrency = settings.account_currency || 'GBP';
          const quoteCurrencyForExit = trade.instrument.split('_')[1];
          const entryForExit = parseFloat(trade.entry_price);
          const absUnitsForExit = Math.abs(parseFloat(trade.units));
          const configuredPct = parseFloat(settings[`risk_pct_${trade.instrument}`] || '2');
          const configuredNotional = configuredPct / 100 * balance;
          const actualNotional = trade.notional_account_ccy ? parseFloat(trade.notional_account_ccy) : configuredNotional;
          const scaleFactor = configuredNotional > 0 ? Math.min(1, actualNotional / configuredNotional) : 1;

          const profitTarget = parseFloat(settings[`profit_target_${trade.instrument}`] || '0');
          if (profitTarget > 0 && absUnitsForExit > 0) {
            const effectiveProfitTarget = profitTarget * scaleFactor;
            enriched.effective_profit_target = effectiveProfitTarget.toFixed(2);
            const exitDiffInQuote = await convertFromAccountCurrency(effectiveProfitTarget, quoteCurrencyForExit, accountCurrency);
            const profitExitPrice = trade.direction === 'buy'
              ? entryForExit + exitDiffInQuote / absUnitsForExit
              : entryForExit - exitDiffInQuote / absUnitsForExit;
            enriched.profit_exit_price = profitExitPrice.toFixed(5);
          }

          const lossTarget = parseFloat(settings[`loss_target_${trade.instrument}`] || '0');
          if (lossTarget > 0 && absUnitsForExit > 0) {
            const effectiveLossTarget = lossTarget * scaleFactor;
            enriched.effective_loss_target = effectiveLossTarget.toFixed(2);
            const exitDiffInQuote = await convertFromAccountCurrency(effectiveLossTarget, quoteCurrencyForExit, accountCurrency);
            // Loss exit moves price against the trade direction
            const lossExitPrice = trade.direction === 'buy'
              ? entryForExit - exitDiffInQuote / absUnitsForExit
              : entryForExit + exitDiffInQuote / absUnitsForExit;
            enriched.loss_exit_price = lossExitPrice.toFixed(5);
          }
        }

        // Potential profit/loss
        const acctCcy = settings.account_currency || 'GBP';
        const entryNum = parseFloat(trade.entry_price);
        const tpNum = parseFloat(trade.tp_price);
        const slNum = parseFloat(trade.sl_price);
        const absUnits = Math.abs(parseFloat(trade.units));
        const quoteCurrency = trade.instrument.split('_')[1]; // e.g. 'JPY' from 'NZD_JPY'

        const rawProfit = (trade.direction === 'buy' ? tpNum - entryNum : entryNum - tpNum) * absUnits;
        const potentialProfit = await convertToAccountCurrency(rawProfit, quoteCurrency, acctCcy);
        enriched.potential_profit = potentialProfit.toFixed(2);
        if (balance > 0) enriched.potential_profit_pct = (potentialProfit / balance * 100).toFixed(2);

        const rawLoss = (trade.direction === 'buy' ? slNum - entryNum : entryNum - slNum) * absUnits;
        const potentialLoss = await convertToAccountCurrency(rawLoss, quoteCurrency, acctCcy);
        enriched.potential_loss = potentialLoss.toFixed(2);
        if (balance > 0) enriched.potential_loss_pct = (potentialLoss / balance * 100).toFixed(2);

        // Peak P/L and Max Drawdown — convert from quote currency to account currency
        const highestNum = trade.highest_price ? parseFloat(trade.highest_price) : null;
        const lowestNum = trade.lowest_price ? parseFloat(trade.lowest_price) : null;
        const peakRef = trade.direction === 'buy' ? highestNum : lowestNum;
        const troughRef = trade.direction === 'buy' ? lowestNum : highestNum;
        if (peakRef !== null) {
          const rawPeak = (trade.direction === 'buy' ? peakRef - entryNum : entryNum - peakRef) * absUnits;
          const peakVal = await convertToAccountCurrency(rawPeak, quoteCurrency, acctCcy);
          enriched.peak_pl = peakVal.toFixed(2);
        }
        if (troughRef !== null) {
          const rawTrough = (trade.direction === 'buy' ? troughRef - entryNum : entryNum - troughRef) * absUnits;
          const troughVal = await convertToAccountCurrency(rawTrough, quoteCurrency, acctCcy);
          enriched.trough_pl = troughVal.toFixed(2);
        }

        return enriched;
      })
    );

    const activeTrades = enrichedTrades.filter(Boolean);

    if (activeTrades.length === 0) {
      console.warn('[STATE] active:false — all trades filtered (broker CLOSED + DB confirmed)');
      return NextResponse.json({ active: false, trades: [], trade: null });
    }

    return NextResponse.json({
      active: true,
      trades: activeTrades,
      trade: activeTrades[0], // backward compat: first trade
    });
  } catch (e) {
    console.error('State fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch state' }, { status: 500 });
  }
}
