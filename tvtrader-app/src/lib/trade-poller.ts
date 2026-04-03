/**
 * trade-poller.ts
 *
 * Server-side background loop — runs independently of any browser connection.
 * Checks all open trades every 2 s (when trades are open) or 10 s (idle).
 * Handles:
 *   - TP / SL detection  (broker closes the trade → we sync status in DB)
 *   - Profit-exit        (unrealizedPL ≥ scaled profit target → we close + record)
 */

import { query, getSettings } from './db';
import { getBroker } from './brokers/factory';
import { syncTradeWithBroker, computeRealizedPL } from './trade-manager';
import { Trade } from '../types';

const POLL_ACTIVE_MS = 2_000;   // while trade(s) open
const POLL_IDLE_MS   = 10_000;  // no open trades

/**
 * Checks the broker for any open trades that are not recorded in our DB and inserts them.
 * Guards against the scenario where a signal was processed and the trade opened on the broker
 * but the DB write failed (e.g. due to a postgres restart mid-request).
 */
async function syncMissingOpenTrades(): Promise<void> {
  try {
    const broker = await getBroker();
    const brokerTrades = await broker.getOpenTrades();
    if (brokerTrades.length === 0) return;

    const dbResult = await query<{ broker_trade_id: string }>(
      `SELECT broker_trade_id FROM trades WHERE status = 'open'`
    );
    const dbTradeIds = new Set(dbResult.rows.map((r) => r.broker_trade_id));

    const settings = await getSettings();
    const leverage = Math.min(Math.max(parseInt(settings.leverage || '1', 10), 1), 30);

    for (const t of brokerTrades) {
      if (dbTradeIds.has(t.brokerTradeId)) continue;

      const instrument = t.instrument;
      const units = t.units;
      const direction = units >= 0 ? 'buy' : 'sell';
      const entryPrice = t.entryPrice.toString();
      const tp = t.takeProfitPrice?.toString() ?? '';
      const sl = t.stopLossPrice?.toString() ?? '';
      const notionalAccountCcy = (t.initialMarginRequired ?? 0).toFixed(2);

      console.log(`[POLLER] Auto-inserting untracked broker trade ${t.brokerTradeId} (${instrument})`);
      await query(
        `INSERT INTO trades (broker_trade_id, broker, instrument, direction, units, entry_price, signal_entry, tp_price, sl_price, notional_account_ccy, leverage_used, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', NOW())`,
        [t.brokerTradeId, broker.brokerName, instrument, direction, units.toString(), entryPrice, entryPrice, tp, sl, notionalAccountCcy, leverage]
      );
      await query(
        `INSERT INTO signal_log (action, instrument, payload, result, success, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['auto_sync', instrument, JSON.stringify({ source: 'poller_broker_sync', tradeId: t.brokerTradeId }), 'trade_synced', true, null]
      );
    }
  } catch (e) {
    console.error('[POLLER] Failed to sync missing open trades from broker:', e);
  }
}

/**
 * For trades closed by profit exit, keep updating highest/lowest price until
 * a TP/SL/exit webhook arrives (which sets peak_tracking_done = true).
 * Safety fallback: also stops if price crosses the original TP or SL level.
 */
async function runPeakTracking(): Promise<void> {
  try {
    const result = await query<Trade>(
      `SELECT * FROM trades WHERE status IN ('exited', 'loss_exited') AND peak_tracking_done = false`
    );
    if (result.rows.length === 0) return;

    const broker = await getBroker();

    for (const trade of result.rows) {
      try {
        const pricingData = await broker.getPricing(trade.instrument).catch(() => null);
        if (!pricingData) continue;

        const mid = (pricingData.ask + pricingData.bid) / 2;

        const tp = parseFloat(trade.tp_price);
        const sl = parseFloat(trade.sl_price);
        const isBuy = trade.direction === 'buy';

        // Safety stop: if price has crossed the original TP or SL, end tracking
        const crossedTP = isBuy ? mid >= tp : mid <= tp;
        const crossedSL = isBuy ? mid <= sl : mid >= sl;
        if (crossedTP || crossedSL) {
          await query(
            `UPDATE trades SET peak_tracking_done = true,
              highest_price = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN $1::text ELSE highest_price END,
              lowest_price  = CASE WHEN $1::numeric < COALESCE(lowest_price::numeric, 9999) THEN $1::text ELSE lowest_price END
             WHERE id = $2`,
            [mid.toFixed(5), trade.id]
          );
          console.log(`[POLLER] Peak tracking ended for ${trade.instrument} (id=${trade.id}) — price crossed ${crossedTP ? 'TP' : 'SL'}`);
          continue;
        }

        // Update high/low
        await query(
          `UPDATE trades SET
            highest_price      = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN $1::text ELSE highest_price END,
            highest_price_time = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN NOW()    ELSE highest_price_time END,
            lowest_price       = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN $2::text ELSE lowest_price END,
            lowest_price_time  = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN NOW()   ELSE lowest_price_time END
           WHERE id = $3`,
          [mid.toFixed(5), mid.toFixed(5), trade.id]
        );
      } catch (e) {
        console.error(`[POLLER] Peak tracking error for trade ${trade.id} (${trade.instrument}):`, e);
      }
    }
  } catch (e) {
    console.error('[POLLER] runPeakTracking error:', e);
  }
}

async function runTradeChecks(): Promise<number> {
  const result = await query<Trade>(`SELECT * FROM trades WHERE status = 'open'`);
  const openTrades = result.rows;

  if (openTrades.length === 0) {
    // No DB records — check broker in case a trade was opened but the DB write failed
    await syncMissingOpenTrades();
    const recheck = await query<Trade>(`SELECT * FROM trades WHERE status = 'open'`);
    if (recheck.rows.length === 0) return 0;
    return recheck.rows.length;
  }

  const broker = await getBroker();
  const [settings, accountData] = await Promise.all([
    getSettings(),
    broker.getAccountSummary().catch(() => null),
  ]);
  const balance = accountData ? accountData.balance : 0;

  for (const trade of openTrades) {
    try {
      const brokerDetails = await broker.getTradeDetails(trade.broker_trade_id).catch(() => null);

      // ── TP / SL sync ──────────────────────────────────────────────────────
      // Only sync on an explicit CLOSED state — null means a network error, not a closure.
      if (brokerDetails === null) continue;
      if (brokerDetails.state === 'CLOSED') {
        await syncTradeWithBroker(trade);
        continue;
      }

      // ── Profit / Loss exit ────────────────────────────────────────────────
      if (balance > 0) {
        const pl = brokerDetails.unrealizedPL;
        const configuredPct    = parseFloat(settings[`risk_pct_${trade.instrument}`] || '2');
        const configuredNotional = configuredPct / 100 * balance;
        const actualNotional   = trade.notional_account_ccy ? parseFloat(trade.notional_account_ccy) : configuredNotional;
        const scaleFactor      = configuredNotional > 0 ? Math.min(1, actualNotional / configuredNotional) : 1;

        let tradeClosed = false;

        const profitTarget = parseFloat(settings[`profit_target_${trade.instrument}`] || '0');
        if (profitTarget > 0) {
          const effectiveTarget = profitTarget * scaleFactor;
          if (pl >= effectiveTarget) {
            console.log(`[POLLER] Profit exit triggered for ${trade.instrument} — closing trade ${trade.broker_trade_id}`);
            const closeResult = await broker.closeTrade(trade.broker_trade_id);
            const closePrice  = closeResult.fillPrice?.toString() || '';
            const closePL     = closePrice ? await computeRealizedPL(trade, closePrice) : (closeResult.realizedPL?.toString() || '0');
            await query(
              `UPDATE trades SET status = 'exited', close_price = $1, realized_pl = $2, closed_at = NOW(), peak_tracking_done = false WHERE id = $3`,
              [closePrice, closePL, trade.id]
            );
            // Signal log is non-critical — don't let it break the close flow
            query(
              `INSERT INTO signal_log (action, instrument, payload, result, success, error)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              ['profit_exit', trade.instrument, JSON.stringify({ source: 'poller', pl, effectiveTarget, closePrice }), 'exited', true, null]
            ).catch((e) => console.warn('[POLLER] signal_log insert failed:', e));
            console.log(`[POLLER] Profit exit complete — ${trade.instrument} closed at ${closePrice}, PL: ${closePL}`);
            tradeClosed = true;
          }
        }

        if (!tradeClosed) {
          const lossTarget = parseFloat(settings[`loss_target_${trade.instrument}`] || '0');
          if (lossTarget > 0) {
            const effectiveTarget = lossTarget * scaleFactor;
            if (pl <= -effectiveTarget) {
              console.log(`[POLLER] Loss exit triggered for ${trade.instrument} — closing trade ${trade.broker_trade_id}`);
              const closeResult = await broker.closeTrade(trade.broker_trade_id);
              const closePrice  = closeResult.fillPrice?.toString() || '';
              const closePL     = closePrice ? await computeRealizedPL(trade, closePrice) : (closeResult.realizedPL?.toString() || '0');
              await query(
                `UPDATE trades SET status = 'loss_exited', close_price = $1, realized_pl = $2, closed_at = NOW(), peak_tracking_done = false WHERE id = $3`,
                [closePrice, closePL, trade.id]
              );
              query(
                `INSERT INTO signal_log (action, instrument, payload, result, success, error)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['loss_exit', trade.instrument, JSON.stringify({ source: 'poller', pl, effectiveTarget, closePrice }), 'exited', true, null]
              ).catch((e) => console.warn('[POLLER] signal_log insert failed:', e));
              console.log(`[POLLER] Loss exit complete — ${trade.instrument} closed at ${closePrice}, PL: ${closePL}`);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[POLLER] Error checking trade ${trade.id} (${trade.instrument}):`, e);
    }
  }

  return openTrades.length;
}

export function startTradePoller() {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    let openCount = 0;
    try {
      openCount = await runTradeChecks();
      await runPeakTracking();
    } catch (e) {
      console.error('[POLLER] Unhandled error in tick:', e);
    } finally {
      running = false;
      const nextMs = openCount > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      setTimeout(tick, nextMs);
    }
  };

  // Kick off after a short delay to let the DB pool initialise
  setTimeout(tick, 3_000);
  console.log('[POLLER] Trade monitoring started — polls every 2 s (active) / 10 s (idle)');
}
