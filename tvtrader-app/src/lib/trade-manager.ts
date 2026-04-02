import { query, getSettings, updateSetting } from './db';
import { getBroker } from './brokers/factory';
import { BrokerAdapter } from './brokers/types';
import { InsufficientMarginError } from './brokers/errors';
import { calcPips, getInstrumentPrecision, formatPrice as formatPriceUtil } from './brokers/instruments';
import { WebhookSignal, Trade } from '../types';

function formatPrice(price: string, instrument: string): string {
  return parseFloat(price).toFixed(getInstrumentPrecision(instrument));
}

// Returns the price of 1 unit of the base currency in account currency (e.g. 1 XAU in GBP)
async function getUnitPriceInAccountCurrency(broker: BrokerAdapter, instrument: string, midPrice: number, accountCurrency: string): Promise<number> {
  const quoteCurrency = instrument.split('_')[1]; // EUR_USD -> USD, XAU_USD -> USD, NZD_JPY -> JPY
  if (quoteCurrency === accountCurrency) return midPrice; // already in account currency
  // Try quoteCcy_accountCcy (e.g. USD_GBP)
  try {
    const p = await broker.getPricing(`${quoteCurrency}_${accountCurrency}`);
    return midPrice * (p.ask + p.bid) / 2;
  } catch {
    // Try accountCcy_quoteCcy (e.g. GBP_USD) and invert
    try {
      const p = await broker.getPricing(`${accountCurrency}_${quoteCurrency}`);
      return midPrice / ((p.ask + p.bid) / 2);
    } catch {
      console.error(`Could not convert ${quoteCurrency} to ${accountCurrency}, using raw mid price`);
      return midPrice;
    }
  }
}

async function logSignal(signal: WebhookSignal, result: string, success: boolean, error?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO signal_log (action, instrument, payload, result, success, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [signal.action, signal.instrument, JSON.stringify(signal), result, success, error || null]
    );
  } catch (e) {
    console.error('Failed to log signal:', e);
  }
}

async function getActiveTradeForInstrument(instrument: string): Promise<Trade | null> {
  const result = await query<Trade>(
    `SELECT * FROM trades WHERE status = 'open' AND instrument = $1 ORDER BY created_at DESC LIMIT 1`,
    [instrument]
  );
  return result.rows[0] || null;
}

async function finalisePeakTracking(instrument: string): Promise<void> {
  try {
    const result = await query<Trade>(
      `SELECT * FROM trades WHERE status = 'exited' AND peak_tracking_done = false AND instrument = $1`,
      [instrument]
    );
    if (result.rows.length === 0) return;

    const broker = await getBroker();
    // Do one final price update then mark done
    const pricingData = await broker.getPricing(instrument).catch(() => null);
    for (const trade of result.rows) {
      if (pricingData) {
        const mid = (pricingData.ask + pricingData.bid) / 2;
        await query(
          `UPDATE trades SET peak_tracking_done = true,
            highest_price      = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN $1::text ELSE highest_price END,
            highest_price_time = CASE WHEN $1::numeric > COALESCE(highest_price::numeric, 0) THEN NOW()    ELSE highest_price_time END,
            lowest_price       = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN $2::text ELSE lowest_price END,
            lowest_price_time  = CASE WHEN $2::numeric < COALESCE(lowest_price::numeric, 9999) THEN NOW()   ELSE lowest_price_time END
           WHERE id = $3`,
          [mid.toFixed(5), mid.toFixed(5), trade.id]
        );
      } else {
        await query(`UPDATE trades SET peak_tracking_done = true WHERE id = $1`, [trade.id]);
      }
      console.log(`[TRADE-MGR] Peak tracking finalised for ${instrument} trade id=${trade.id}`);
    }
  } catch (e) {
    console.error(`[TRADE-MGR] finalisePeakTracking error for ${instrument}:`, e);
  }
}


export async function handleBuySell(signal: WebhookSignal): Promise<{ success: boolean; message: string }> {
  const existingTrade = await getActiveTradeForInstrument(signal.instrument);
  if (existingTrade) {
    await logSignal(signal, 'rejected_trade_open', false, 'Trade already open for this instrument');
    return { success: false, message: `Trade already open for ${signal.instrument}` };
  }

  const broker = await getBroker();

  const [accountSummary, pricingResult] = await Promise.all([
    broker.getAccountSummary(),
    broker.getPricing(signal.instrument).catch((e) => {
      console.warn(`[TRADE] Market data unavailable for ${signal.instrument}, using signal entry price: ${e.message}`);
      return null;
    }),
  ]);

  // Fall back to signal entry price if broker market data is unavailable
  const entryFallback = parseFloat(signal.entry!);
  const pricing = pricingResult ?? { instrument: signal.instrument, bid: entryFallback, ask: entryFallback };

  const settings = await getSettings();

  // Seed per-pair risk defaults if not set
  const pairDefaults: Record<string, string> = {
    risk_pct_EUR_USD: '90',
    risk_pct_XAU_USD: '5',
    risk_pct_NZD_JPY: '5',
    enabled_EUR_USD: 'true',
    enabled_XAU_USD: 'true',
    enabled_NZD_JPY: 'true',
  };
  for (const [key, val] of Object.entries(pairDefaults)) {
    if (!settings[key]) {
      await updateSetting(key, val);
      settings[key] = val;
    }
  }

  const leverage = Math.min(Math.max(parseInt(settings.leverage || '1', 10), 1), 30);

  // Check if this pair is enabled
  const enabledKey = `enabled_${signal.instrument}`;
  if (settings[enabledKey] === 'false') {
    const reason = `Rejected: ${signal.instrument} is disabled in settings`;
    await logSignal(signal, 'rejected_pair_disabled', false, reason);
    return { success: false, message: reason };
  }

  // Per-pair risk percentage
  const pairKey = `risk_pct_${signal.instrument}`;
  const riskPercentage = parseFloat(settings[pairKey] || settings.risk_percentage || '2');

  const balance = accountSummary.balance;

  // Calculate balance % already committed by open trades (using their full configured %)
  const openTradesResult = await query<{ instrument: string }>(
    `SELECT instrument FROM trades WHERE status = 'open'`
  );
  let usedPct = 0;
  for (const row of openTradesResult.rows) {
    if (row.instrument === signal.instrument) continue;
    const instKey = `risk_pct_${row.instrument}`;
    usedPct += parseFloat(settings[instKey] || '2');
  }

  const availablePct = Math.max(0, 100 - usedPct);
  // Effective = whatever the pair is configured for, clipped to what's actually free
  const effectivePct = Math.min(riskPercentage, availablePct);

  if (effectivePct <= 0) {
    const reason = `Rejected: no margin available — ${usedPct.toFixed(1)}% of balance already committed by open trades`;
    await logSignal(signal, 'rejected_no_margin', false, reason);
    return { success: false, message: reason };
  }

  const ask = pricing.ask;
  const bid = pricing.bid;
  const spread = (ask - bid).toFixed(6);

  const mid = (ask + bid) / 2;
  const unitPriceInAccountCcy = await getUnitPriceInAccountCurrency(broker, signal.instrument, mid, accountSummary.currency);
  const notionalAccountCcy = effectivePct / 100 * balance;
  const configuredUnits = Math.max(1, Math.floor(notionalAccountCcy * leverage / unitPriceInAccountCcy));

  // Cap units to what the broker's available margin can actually support.
  const marginAvailable = accountSummary.marginAvailable;
  const maxAffordableUnits = marginAvailable > 0 && unitPriceInAccountCcy > 0
    ? Math.floor(marginAvailable * leverage / unitPriceInAccountCcy)
    : configuredUnits;
  const units = Math.max(1, Math.min(configuredUnits, maxAffordableUnits));
  if (units < configuredUnits) {
    console.warn(`[TRADE] Downscaled ${signal.instrument} from ${configuredUnits} to ${units} units — margin available ${accountSummary.currency}${marginAvailable.toFixed(2)}`);
  }

  const entryPrice = parseFloat(signal.entry!);
  const tp1Price = parseFloat(signal.tp1!);
  let direction = signal.action as 'buy' | 'sell';

  // Auto-correct direction if signal and prices are inconsistent
  if (direction === 'buy' && tp1Price < entryPrice) {
    direction = 'sell';
  } else if (direction === 'sell' && tp1Price > entryPrice) {
    direction = 'buy';
  }

  // Slippage check — per-pair setting takes precedence over global
  const settingsMap = settings as Record<string, string>;
  const maxSlippage = parseFloat(
    settingsMap[`max_slippage_pips_${signal.instrument}`] || settings.max_slippage_pips || '3'
  );
  if (maxSlippage > 0) {
    const slippage = direction === 'buy'
      ? calcPips(ask, entryPrice, signal.instrument)
      : calcPips(entryPrice, bid, signal.instrument);
    if (slippage > maxSlippage) {
      const msg = `Slippage ${slippage.toFixed(1)} pips exceeds max ${maxSlippage} pips (${direction === 'buy' ? 'ask' : 'bid'}=${direction === 'buy' ? ask : bid}, signal entry=${entryPrice})`;
      await logSignal(signal, 'rejected_slippage', false, msg);
      return { success: false, message: msg };
    }
  }

  const tpNum = parseFloat(signal.tp1!);
  const slNum = parseFloat(signal.sl!);

  // Place order. If broker rejects with INSUFFICIENT_MARGIN (race condition between
  // our margin check and the order), reduce by 25% and retry once as a safety net.
  let attemptUnits = units;
  let signedUnits = direction === 'sell' ? -attemptUnits : attemptUnits;
  let orderResult;
  for (let attempt = 0; attempt < 2; attempt++) {
    signedUnits = direction === 'sell' ? -attemptUnits : attemptUnits;
    try {
      orderResult = await broker.placeMarketOrder(signal.instrument, signedUnits, tpNum, slNum);
      break;
    } catch (e) {
      if (e instanceof InsufficientMarginError && attemptUnits > 1 && attempt === 0) {
        const reduced = Math.max(1, Math.floor(attemptUnits * 0.75));
        console.warn(`[TRADE] INSUFFICIENT_MARGIN safety-net: retrying ${signal.instrument} with ${reduced} units`);
        attemptUnits = reduced;
        continue;
      }
      throw e;
    }
  }

  // Rebase units/notional to what was actually attempted
  const unitsStr = direction === 'sell' ? `-${attemptUnits}` : `${attemptUnits}`;
  const notionalAccountCcyActual = (attemptUnits * unitPriceInAccountCcy / leverage).toFixed(2);

  if (!orderResult!.filled) {
    const reason = orderResult!.rejectedReason || 'Unknown rejection';
    await logSignal(signal, 'order_rejected', false, reason);
    return { success: false, message: `Order rejected: ${reason}` };
  }

  const tradeId = orderResult!.brokerTradeId!;
  const fillPrice = orderResult!.fillPrice!;
  const slippage = (direction === 'buy'
    ? calcPips(fillPrice, entryPrice, signal.instrument)
    : calcPips(entryPrice, fillPrice, signal.instrument)).toFixed(1);

  try {
    await query(
      `INSERT INTO trades (broker_trade_id, broker, instrument, direction, units, entry_price, signal_entry, tp_price, sl_price, spread_at_entry, slippage_pips, status, highest_price, lowest_price, notional_account_ccy, leverage_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, $12, $13, $14)`,
      [tradeId, broker.brokerName, signal.instrument, direction, unitsStr, fillPrice.toString(), signal.entry, signal.tp1, signal.sl, spread, slippage, fillPrice.toString(), notionalAccountCcyActual, leverage]
    );
  } catch (e) {
    console.error('Failed to insert trade:', e);
    await logSignal(signal, 'trade_opened_db_failed', false, String(e));
    return { success: false, message: `Trade opened on broker but DB record failed: ${e}` };
  }

  await logSignal(signal, 'trade_opened', true);

  // Verify TP/SL after 10 seconds
  setTimeout(async () => {
    try {
      const brokerForVerify = await getBroker();
      const details = await brokerForVerify.getTradeDetails(tradeId);
      const hasTP = details.takeProfitPrice !== undefined || details.takeProfitFilled;
      const hasSL = details.stopLossPrice !== undefined || details.stopLossFilled;
      if (hasTP && hasSL) {
        return;
      }
      const missing = hasTP ? 'SL' : 'TP';
      console.error(`MISSING ${missing} ORDER on trade ${tradeId} — closing trade`);
      const closeResult = await brokerForVerify.closeTrade(tradeId);
      const closePrice = closeResult.fillPrice?.toString() || '';
      const closePL = closeResult.realizedPL?.toString() || '0';
      const closeStatus = hasTP ? 'exited_no_sl' : 'exited_no_tp';
      await query(
        'UPDATE trades SET status = $1, close_price = $2, realized_pl = $3, closed_at = NOW() WHERE broker_trade_id = $4',
        [closeStatus, closePrice, closePL, tradeId]
      );
      await query(
        `INSERT INTO signal_log (action, instrument, payload, result, success, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [direction, signal.instrument, JSON.stringify({ tradeId, missing }), closeStatus, false, `Missing ${missing} order — trade closed`]
      );
    } catch (e) {
      console.error(`TP/SL verification failed for trade ${tradeId}:`, e);
    }
  }, 10000);

  return { success: true, message: `Trade opened: ${tradeId}` };
}

export async function handleTpSl(signal: WebhookSignal): Promise<{ success: boolean; message: string }> {
  const trade = await getActiveTradeForInstrument(signal.instrument);
  if (!trade) {
    // Check if the trade was already closed — not an error, just late/redundant webhook
    const recent = await query<{ status: string; closed_at: string }>(
      `SELECT status, closed_at FROM trades WHERE instrument = $1 AND status != 'open'
       ORDER BY closed_at DESC LIMIT 1`,
      [signal.instrument]
    );
    if (recent.rows.length > 0) {
      const { status: closedStatus } = recent.rows[0];
      const reason = closedStatus === 'exited'
        ? 'already_profit_exited'
        : closedStatus === 'tp_hit'
        ? 'already_tp_hit'
        : closedStatus === 'sl_hit'
        ? 'already_sl_hit'
        : 'already_closed';
      await logSignal(signal, reason, true, `Trade was already closed on Exchange before webhook arrived (${closedStatus})`);
      await finalisePeakTracking(signal.instrument);
      return { success: true, message: `Acknowledged — trade already closed as ${closedStatus}` };
    }
    await logSignal(signal, 'no_active_trade', false, 'No active trade found');
    return { success: false, message: 'No active trade' };
  }

  try {
    const broker = await getBroker();
    const openTrades = await broker.getOpenTrades();
    const isStillOpen = openTrades.some((t) => t.brokerTradeId === trade.broker_trade_id);

    let closePrice = '';
    let closePL = '';
    let highestPrice: string | null = null;
    let lowestPrice: string | null = null;

    if (isStillOpen) {
      const closeResult = await broker.closeTrade(trade.broker_trade_id);
      if (closeResult.fillPrice !== undefined) {
        closePrice = closeResult.fillPrice.toString();
      }
      if (closeResult.realizedPL !== undefined) {
        closePL = closeResult.realizedPL.toString();
      }
      try {
        const details = await broker.getTradeDetails(trade.broker_trade_id);
        highestPrice = details.highestPrice?.toString() || null;
        lowestPrice = details.lowestPrice?.toString() || null;
      } catch { /* ignore */ }
    } else {
      try {
        const details = await broker.getTradeDetails(trade.broker_trade_id);
        closePrice = details.averageClosePrice?.toString() || '';
        closePL = details.realizedPL?.toString() || '0';
        highestPrice = details.highestPrice?.toString() || null;
        lowestPrice = details.lowestPrice?.toString() || null;
      } catch {
        try {
          const closed = await broker.getClosedTrades(20);
          const found = closed.find((t) => t.brokerTradeId === trade.broker_trade_id);
          if (found) {
            closePrice = found.averageClosePrice?.toString() || '';
            closePL = found.realizedPL?.toString() || '0';
            highestPrice = found.highestPrice?.toString() || null;
            lowestPrice = found.lowestPrice?.toString() || null;
          } else {
            closePrice = signal.action === 'tp1' ? trade.tp_price : trade.sl_price;
            closePL = '0';
          }
        } catch {
          closePrice = signal.action === 'tp1' ? trade.tp_price : trade.sl_price;
          closePL = '0';
        }
      }
    }

    // tp1, tp2, tp3 all close as tp_hit; sl closes as sl_hit
    const status = (signal.action === 'sl') ? 'sl_hit' : 'tp_hit';

    await query(
      `UPDATE trades
       SET status = $1, close_price = $2, realized_pl = $3, closed_at = NOW(),
           highest_price = CASE WHEN $5::text IS NOT NULL AND ($5::numeric > COALESCE(highest_price::numeric, 0)) THEN $5::text ELSE highest_price END,
           lowest_price  = CASE WHEN $6::text IS NOT NULL AND ($6::numeric < COALESCE(lowest_price::numeric, 9999)) THEN $6::text ELSE lowest_price END
       WHERE id = $4`,
      [status, closePrice, closePL, trade.id, highestPrice, lowestPrice]
    );

    await logSignal(signal, `trade_closed_${status}`, true);
    await finalisePeakTracking(signal.instrument);
    return { success: true, message: `Trade closed: ${status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSignal(signal, 'close_error', false, msg);
    return { success: false, message: msg };
  }
}

export async function handleExit(signal: WebhookSignal): Promise<{ success: boolean; message: string }> {
  const trade = await getActiveTradeForInstrument(signal.instrument);
  if (!trade) {
    const recent = await query<{ status: string }>(
      `SELECT status FROM trades WHERE instrument = $1 AND status != 'open'
       ORDER BY closed_at DESC LIMIT 1`,
      [signal.instrument]
    );
    if (recent.rows.length > 0) {
      const { status: closedStatus } = recent.rows[0];
      await logSignal(signal, 'already_closed', true, `Trade was already closed on Exchange before webhook arrived (${closedStatus})`);
      await finalisePeakTracking(signal.instrument);
      return { success: true, message: `Acknowledged — trade already closed as ${closedStatus}` };
    }
    await logSignal(signal, 'no_active_trade', false, 'No active trade found');
    return { success: false, message: 'No active trade' };
  }

  try {
    const broker = await getBroker();
    const closeResult = await broker.closeTrade(trade.broker_trade_id);
    const closePrice = closeResult.fillPrice?.toString() || '';
    const closePL = closeResult.realizedPL?.toString() || '';
    await query(
      'UPDATE trades SET status = \'exited\', close_price = $1, realized_pl = $2, closed_at = NOW() WHERE id = $3',
      [closePrice, closePL, trade.id]
    );
    await logSignal(signal, 'trade_exited', true);
    await finalisePeakTracking(signal.instrument);
    return { success: true, message: 'Trade exited' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logSignal(signal, 'exit_error', false, msg);
    return { success: false, message: msg };
  }
}

export async function syncTradeWithBroker(trade: Trade): Promise<boolean> {
  try {
    const broker = await getBroker();
    const openTrades = await broker.getOpenTrades();
    if (openTrades.some((t) => t.brokerTradeId === trade.broker_trade_id)) {
      return false;
    }

    // Check closed trades list
    const closedTrades = await broker.getClosedTrades(50);
    const found = closedTrades.find((t) => t.brokerTradeId === trade.broker_trade_id);
    if (found) {
      const status = found.takeProfitFilled ? 'tp_hit'
        : found.stopLossFilled ? 'sl_hit'
        : 'exited';
      const closePrice = found.averageClosePrice?.toString() || trade.tp_price;
      const closePL = found.realizedPL?.toString() || '0';
      const closedAt = found.closeTime || new Date().toISOString();
      const highestPrice = found.highestPrice?.toString() || null;
      const lowestPrice = found.lowestPrice?.toString() || null;

      await query(
        `UPDATE trades
         SET status = $1, close_price = $2, realized_pl = $3, closed_at = $4,
             highest_price = CASE WHEN $6::text IS NOT NULL AND ($6::numeric > COALESCE(highest_price::numeric, 0)) THEN $6::text ELSE highest_price END,
             lowest_price  = CASE WHEN $7::text IS NOT NULL AND ($7::numeric < COALESCE(lowest_price::numeric, 9999)) THEN $7::text ELSE lowest_price END
         WHERE id = $5`,
        [status, closePrice, closePL, closedAt, trade.id, highestPrice, lowestPrice]
      );
      await query(
        `INSERT INTO signal_log (action, instrument, payload, result, success, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['auto_sync', trade.instrument, JSON.stringify({ broker_trade_id: trade.broker_trade_id, source: 'closed_trades', realizedPL: closePL, closePrice }), status, true, null]
      );
      console.log(`[SYNC] Trade ${trade.broker_trade_id} synced as ${status}, PL: ${closePL}`);
      return true;
    }

    if (await syncFromTransactions(trade)) return true;
    return await syncFromPrice(trade);
  } catch (e) {
    console.error(`[SYNC] Failed for trade ${trade.broker_trade_id}:`, e);
    return false;
  }
}

async function syncFromTransactions(trade: Trade): Promise<boolean> {
  try {
    const broker = await getBroker();
    const txns = await broker.getTransactionsSinceId(trade.broker_trade_id);
    const fillTxn = txns.find(
      (t) => t.type === 'ORDER_FILL' && (t.brokerTradeId === trade.broker_trade_id || t.tradesClosed?.some((tc) => tc.brokerTradeId === trade.broker_trade_id))
    );
    if (!fillTxn) return false;

    const closed = fillTxn.tradesClosed?.find((tc) => tc.brokerTradeId === trade.broker_trade_id);
    const status = fillTxn.reason === 'TAKE_PROFIT_ORDER' ? 'tp_hit'
      : fillTxn.reason === 'STOP_LOSS_ORDER' ? 'sl_hit'
      : 'exited';
    const closePrice = closed?.price?.toString() || fillTxn.price?.toString() || trade.tp_price;
    const closePL = closed?.realizedPL?.toString() || fillTxn.realizedPL?.toString() || '0';
    const closedAt = fillTxn.time || new Date().toISOString();

    await query(
      'UPDATE trades SET status = $1, close_price = $2, realized_pl = $3, closed_at = $4 WHERE id = $5',
      [status, closePrice, closePL, closedAt, trade.id]
    );
    await query(
      `INSERT INTO signal_log (action, instrument, payload, result, success, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['auto_sync', trade.instrument, JSON.stringify({ broker_trade_id: trade.broker_trade_id, source: 'transactions', realizedPL: closePL, closePrice }), status, true, null]
    );
    console.log(`[SYNC] Trade ${trade.broker_trade_id} synced from transactions as ${status}, PL: ${closePL}`);
    return true;
  } catch (e) {
    console.error(`[SYNC] Transaction lookup failed for trade ${trade.broker_trade_id}:`, e);
    return false;
  }
}

async function syncFromPrice(trade: Trade): Promise<boolean> {
  const broker = await getBroker();
  const pricing = await broker.getPricing(trade.instrument).catch(() => null);
  if (!pricing) return false;
  const mid = (pricing.ask + pricing.bid) / 2;
  const tp = parseFloat(trade.tp_price);
  const sl = parseFloat(trade.sl_price);

  let status: string | null = null;
  if (trade.direction === 'buy') {
    if (mid >= tp) status = 'tp_hit';
    else if (mid <= sl) status = 'sl_hit';
  } else {
    if (mid <= tp) status = 'tp_hit';
    else if (mid >= sl) status = 'sl_hit';
  }

  if (!status) {
    return false;
  }

  const closePrice = status === 'tp_hit' ? trade.tp_price : trade.sl_price;
  await query(
    'UPDATE trades SET status = $1, close_price = $2, realized_pl = \'0\', closed_at = NOW() WHERE id = $3',
    [status, closePrice, trade.id]
  );
  await query(
    `INSERT INTO signal_log (action, instrument, payload, result, success, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['auto_sync', trade.instrument, JSON.stringify({ broker_trade_id: trade.broker_trade_id, source: 'price_inference', currentPrice: mid, tp, sl }), status, true, 'inferred from current price']
  );
  console.log(`[SYNC] Trade ${trade.broker_trade_id} inferred as ${status} from price ${mid}`);
  return true;
}
