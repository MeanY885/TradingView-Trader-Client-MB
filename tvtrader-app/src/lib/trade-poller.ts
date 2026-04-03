/**
 * trade-poller.ts
 *
 * Server-side background loop — runs independently of any browser connection.
 * Two loops run concurrently:
 *   1. Fast P/L monitor (~200ms) — tight price-check loop for profit/loss exits
 *   2. Slow sync loop (10s)      — TP/SL sync, peak tracking, orphan detection
 */

import { query, getSettings } from './db';
import { getBroker } from './brokers/factory';
import { syncTradeWithBroker, computeRealizedPL } from './trade-manager';
import { Trade } from '../types';

const PL_MONITOR_MS  = 200;    // P/L check interval — as fast as IB snapshot allows
const SYNC_IDLE_MS   = 10_000; // no open trades
const SYNC_ACTIVE_MS = 5_000;  // TP/SL sync + peak tracking (less urgent)

// ─── Fast P/L Monitor ───────────────────────────────────────────────────────
// Tight loop: get price → compute P/L → close if threshold hit.
// Pre-caches settings, balance, and FX rate so each iteration is a single
// HTTP call (snapshot) + arithmetic.

interface MonitorCache {
  balance: number;
  settings: Record<string, string>;
  fxRate: number;        // quote-currency → account-currency rate
  acctCcy: string;
  ts: number;
}

let monitorCache: MonitorCache | null = null;
const CACHE_TTL = 30_000; // refresh settings/balance every 30s

async function refreshMonitorCache(): Promise<MonitorCache> {
  const broker = await getBroker();
  const [settings, accountData] = await Promise.all([
    getSettings(),
    broker.getAccountSummary().catch(() => null),
  ]);
  const balance = accountData ? accountData.balance : 0;
  const acctCcy = settings.account_currency || 'USD';

  // Pre-fetch EUR_USD (or whatever) FX rate for converting quote-ccy P/L to account ccy.
  // For EUR_USD trades, quote is USD. We need USD→acctCcy rate.
  // If acctCcy is USD, rate is 1. Otherwise get it from pricing.
  let fxRate = 1;
  if (acctCcy !== 'USD') {
    try {
      const pair = `USD_${acctCcy}`;
      const pricing = await broker.getPricing(pair);
      fxRate = (pricing.ask + pricing.bid) / 2;
    } catch {
      // Fallback: try inverse
      try {
        const pair = `${acctCcy}_USD`;
        const pricing = await broker.getPricing(pair);
        fxRate = 1 / ((pricing.ask + pricing.bid) / 2);
      } catch { fxRate = 1; }
    }
  }

  monitorCache = { balance, settings, fxRate, acctCcy, ts: Date.now() };
  return monitorCache;
}

async function getMonitorCache(): Promise<MonitorCache> {
  if (monitorCache && Date.now() - monitorCache.ts < CACHE_TTL) return monitorCache;
  return refreshMonitorCache();
}

async function runPLMonitor(): Promise<void> {
  const result = await query<Trade>(`SELECT * FROM trades WHERE status = 'open'`);
  const openTrades = result.rows;
  if (openTrades.length === 0) return;

  const broker = await getBroker();
  const cache = await getMonitorCache();
  if (cache.balance <= 0) return;

  // Get pricing for all open instruments in one batch
  const instruments = [...new Set(openTrades.map((t) => t.instrument))];
  const prices = new Map<string, number>();
  try {
    const quotes = await broker.getPricingMulti(instruments);
    for (const q of quotes) {
      if (q.ask > 0 && q.bid > 0) prices.set(q.instrument, (q.ask + q.bid) / 2);
    }
  } catch { return; } // pricing failed, skip this cycle

  for (const trade of openTrades) {
    const mid = prices.get(trade.instrument);
    if (!mid) continue;

    const entry = parseFloat(trade.entry_price);
    const units = parseFloat(trade.units); // signed: +long, -short
    if (!entry || !units) continue;

    // Compute P/L: (price - entry) * units gives P/L in quote currency
    const rawPL = (mid - entry) * units;
    // Convert to account currency using cached FX rate
    const quoteCcy = trade.instrument.split('_')[1];
    const pl = quoteCcy === cache.acctCcy ? rawPL : rawPL * cache.fxRate;

    // Compute effective targets (scaled by actual vs configured notional)
    const configuredPct = parseFloat(cache.settings[`risk_pct_${trade.instrument}`] || '2');
    const configuredNotional = configuredPct / 100 * cache.balance;
    const actualNotional = trade.notional_account_ccy ? parseFloat(trade.notional_account_ccy) : configuredNotional;
    const scaleFactor = configuredNotional > 0 ? Math.min(1, actualNotional / configuredNotional) : 1;

    const profitTarget = parseFloat(cache.settings[`profit_target_${trade.instrument}`] || '0');
    const lossTarget = parseFloat(cache.settings[`loss_target_${trade.instrument}`] || '0');
    const effectiveProfitTarget = profitTarget > 0 ? profitTarget * scaleFactor : 0;
    const effectiveLossTarget = lossTarget > 0 ? lossTarget * scaleFactor : 0;

    // Check both thresholds — no priority, whichever is hit first
    let exitType: 'profit' | 'loss' | null = null;
    let effectiveTarget = 0;
    if (effectiveLossTarget > 0 && pl <= -effectiveLossTarget) {
      exitType = 'loss';
      effectiveTarget = effectiveLossTarget;
    } else if (effectiveProfitTarget > 0 && pl >= effectiveProfitTarget) {
      exitType = 'profit';
      effectiveTarget = effectiveProfitTarget;
    }

    if (!exitType) continue;

    // ── CLOSE IMMEDIATELY ──────────────────────────────────────────────────
    const status = exitType === 'loss' ? 'loss_exited' : 'exited';
    const action = exitType === 'loss' ? 'loss_exit' : 'profit_exit';
    console.log(`[POLLER] ${action} triggered for ${trade.instrument} — PL: ${pl.toFixed(2)}, target: ${effectiveTarget.toFixed(2)} — closing now`);

    try {
      const closeResult = await broker.closeTrade(trade.broker_trade_id);
      const closePrice = closeResult.fillPrice?.toString() || '';
      const closePL = closePrice ? await computeRealizedPL(trade, closePrice) : pl.toFixed(2);

      await query(
        `UPDATE trades SET status = $1, close_price = $2, realized_pl = $3, closed_at = NOW(), peak_tracking_done = false WHERE id = $4`,
        [status, closePrice, closePL, trade.id]
      );
      query(
        `INSERT INTO signal_log (action, instrument, payload, result, success, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [action, trade.instrument, JSON.stringify({ source: 'poller', pl: pl.toFixed(2), effectiveTarget, closePrice, mid }), status, true, null]
      ).catch((e) => console.warn('[POLLER] signal_log insert failed:', e));

      console.log(`[POLLER] ${action} complete — ${trade.instrument} closed at ${closePrice}, PL: ${closePL}`);
      // Invalidate cache so next cycle picks up new balance
      monitorCache = null;
    } catch (e) {
      console.error(`[POLLER] ${action} failed for ${trade.instrument}:`, e);
    }
  }
}

// ─── Slow Sync Loop ─────────────────────────────────────────────────────────
// Handles TP/SL detection (broker-side closes), peak tracking, orphan sync.
// Runs less frequently since these aren't latency-sensitive.

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
      query(
        `INSERT INTO signal_log (action, instrument, payload, result, success, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['auto_sync', instrument, JSON.stringify({ source: 'poller_broker_sync', tradeId: t.brokerTradeId }), 'trade_synced', true, null]
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[POLLER] Failed to sync missing open trades from broker:', e);
  }
}

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

async function runSyncChecks(): Promise<number> {
  const result = await query<Trade>(`SELECT * FROM trades WHERE status = 'open'`);
  const openTrades = result.rows;

  if (openTrades.length === 0) {
    await syncMissingOpenTrades();
    const recheck = await query<Trade>(`SELECT * FROM trades WHERE status = 'open'`);
    return recheck.rows.length;
  }

  const broker = await getBroker();

  // Check for broker-side closures (TP/SL hit on broker)
  for (const trade of openTrades) {
    try {
      const positions = await broker.getOpenTrades().catch(() => []);
      const stillOpen = positions.some((p) => p.brokerTradeId === trade.broker_trade_id);
      if (!stillOpen) {
        // Position gone — broker closed it (TP/SL)
        await syncTradeWithBroker(trade);
      }
    } catch (e) {
      console.error(`[POLLER] Sync error for trade ${trade.id}:`, e);
    }
  }

  return openTrades.length;
}

// ─── Start ──────────────────────────────────────────────────────────────────

export function startTradePoller() {
  let plRunning = false;
  let syncRunning = false;

  // Fast loop: P/L monitoring — ~200ms cycles
  const plTick = async () => {
    if (plRunning) return;
    plRunning = true;
    try {
      await runPLMonitor();
    } catch (e) {
      console.error('[POLLER] P/L monitor error:', e);
    } finally {
      plRunning = false;
      // Check if there are open trades to decide interval
      const hasOpen = (await query<{ count: string }>(`SELECT count(*) FROM trades WHERE status = 'open'`).catch(() => ({ rows: [{ count: '0' }] }))).rows[0];
      const nextMs = parseInt(hasOpen.count) > 0 ? PL_MONITOR_MS : SYNC_IDLE_MS;
      setTimeout(plTick, nextMs);
    }
  };

  // Slow loop: sync + peak tracking
  const syncTick = async () => {
    if (syncRunning) return;
    syncRunning = true;
    let openCount = 0;
    try {
      openCount = await runSyncChecks();
      await runPeakTracking();
    } catch (e) {
      console.error('[POLLER] Sync tick error:', e);
    } finally {
      syncRunning = false;
      const nextMs = openCount > 0 ? SYNC_ACTIVE_MS : SYNC_IDLE_MS;
      setTimeout(syncTick, nextMs);
    }
  };

  setTimeout(plTick, 3_000);
  setTimeout(syncTick, 5_000);
  console.log('[POLLER] Trade monitoring started — P/L monitor: 200ms, sync: 5s/10s');
}
