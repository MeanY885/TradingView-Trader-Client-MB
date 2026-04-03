import { NextResponse } from 'next/server';
import { query, getSettings } from '../../../lib/db';

interface TradeRow {
  instrument: string;
  direction: string;
  status: string;
  realized_pl: string | null;
  entry_price: string;
  close_price: string | null;
  highest_price: string | null;
  lowest_price: string | null;
  notional_account_ccy: string | null;
}

export interface PairAnalysis {
  instrument: string;
  tradeCount: number;
  currentExit: number;
  safeExit: number;          // highest £ level 90%+ of trades passed through, scaled to current notional
  safeExitPct: number;       // safe exit as % of notional (normalised, portable)
  winRateAtSafe: number;
  winRateAtCurrent: number;
  hitsAtCurrent: number;     // raw count of trades that peaked at or above currentExit
  direction: 'increase' | 'decrease' | 'optimal';
}

// Peak favourable P&L in account currency (£), estimated from price high/low and realized P&L.
// Works without notional_account_ccy — the ratio of peakMove/priceAtClose scales realized_pl to the peak.
function peakPL(trade: TradeRow): number {
  const entry = parseFloat(trade.entry_price);
  const close = parseFloat(trade.close_price || '0');
  const realPl = parseFloat(trade.realized_pl || '0');

  if (!close || close === entry) return Math.max(0, realPl);

  const priceAtClose = trade.direction === 'buy' ? close - entry : entry - close;
  if (priceAtClose === 0) return Math.max(0, realPl);

  const peakPrice = trade.direction === 'buy'
    ? parseFloat(trade.highest_price || String(close))
    : parseFloat(trade.lowest_price || String(close));

  const peakMove = trade.direction === 'buy' ? peakPrice - entry : entry - peakPrice;
  const peak = realPl * (peakMove / priceAtClose);
  return Math.max(0, peak);
}

// Normalised peak as a fraction of notional — used for safeExit cross-trade comparison.
// Returns null when notional_account_ccy is missing (older trades).
function peakRatio(trade: TradeRow): number | null {
  const notional = parseFloat(trade.notional_account_ccy || '0');
  if (!notional) return null;
  const peak = peakPL(trade);
  return peak / notional;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const balance = parseFloat(searchParams.get('balance') || '0');

    const result = await query<TradeRow>(
      `SELECT instrument, direction, status, realized_pl,
              entry_price, close_price, highest_price, lowest_price, notional_account_ccy
       FROM trades
       WHERE status IN ('tp_hit', 'sl_hit', 'exited', 'loss_exited')
       ORDER BY created_at ASC`
    );
    const settings = await getSettings();

    const byPair: Record<string, TradeRow[]> = {};
    for (const row of result.rows) {
      if (!byPair[row.instrument]) byPair[row.instrument] = [];
      byPair[row.instrument].push(row);
    }

    const analysis: Record<string, PairAnalysis> = {};

    for (const [instrument, trades] of Object.entries(byPair)) {
      const currentExit = parseFloat(
        (settings[`profit_target_${instrument}`] as string) || '0'
      );
      const riskPct = parseFloat(
        (settings[`risk_pct_${instrument}`] as string) || '0'
      );
      const currentNotional = balance > 0 && riskPct > 0
        ? balance * riskPct / 100
        : 0;

      if (trades.length < 5) {
        const hitsAtCurrent = currentExit <= 0 ? trades.length
          : trades.filter(t => peakPL(t) >= currentExit).length;
        const winRateAtCurrent = trades.length > 0
          ? Math.round(hitsAtCurrent / trades.length * 100) : 0;
        analysis[instrument] = {
          instrument, tradeCount: trades.length,
          currentExit, safeExit: 0, safeExitPct: 0,
          winRateAtSafe: 0, winRateAtCurrent, hitsAtCurrent,
          direction: 'optimal',
        };
        continue;
      }

      // Normalise each trade's peak P&L to a fraction of its own notional
      const ratios = trades
        .map(peakRatio)
        .filter((r): r is number => r !== null)
        .sort((a, b) => a - b);

      if (ratios.length < 5) {
        // Not enough notional_account_ccy data for normalised ratios — compute safeExit from raw £ peaks instead
        const peaks = trades.map(peakPL).sort((a, b) => a - b);
        const idx10 = Math.floor(peaks.length * 0.10);
        const safeExitRaw = peaks[idx10] ?? 0;
        const safeExit = Math.max(5, Math.floor(safeExitRaw / 5) * 5);

        const hitsAtCurrent = currentExit <= 0 ? trades.length
          : trades.filter(t => peakPL(t) >= currentExit).length;
        const winRateAtCurrent = Math.round(hitsAtCurrent / trades.length * 100);
        const winRateAtSafe = safeExitRaw <= 0 ? 100
          : Math.round(peaks.filter(p => p >= safeExitRaw).length / peaks.length * 100);

        const tolerance = 5;
        const direction =
          Math.abs(safeExit - currentExit) <= tolerance ? 'optimal'
          : safeExit > currentExit ? 'increase'
          : 'decrease';

        analysis[instrument] = {
          instrument, tradeCount: trades.length,
          currentExit, safeExit, safeExitPct: 0,
          winRateAtSafe, winRateAtCurrent, hitsAtCurrent,
          direction,
        };
        continue;
      }

      // 10th percentile of peak ratios = ratio that 90%+ of trades exceeded
      const idx10 = Math.floor(ratios.length * 0.10);
      const safeRatio = ratios[idx10] ?? 0;

      // Convert ratio → £ using CURRENT account size & risk %
      const safeExitRaw = currentNotional > 0 ? safeRatio * currentNotional : 0;
      const safeExit = Math.max(5, Math.floor(safeExitRaw / 5) * 5);
      const safeExitPct = Math.round(safeRatio * 1000) / 10; // e.g. 0.05 → 5.0%

      // Safe exit hit rate — uses normalised ratios (consistent across account sizes)
      const winRateAtSafe = safeRatio <= 0 ? 100
        : Math.round(ratios.filter(r => r >= safeRatio).length / ratios.length * 100);

      // Current exit hit rate — direct £ comparison against all trades (no notional needed)
      const hitsAtCurrent = currentExit <= 0 ? trades.length
        : trades.filter(t => peakPL(t) >= currentExit).length;
      const winRateAtCurrent = Math.round(hitsAtCurrent / trades.length * 100);

      const tolerance = 5;
      const direction =
        Math.abs(safeExit - currentExit) <= tolerance ? 'optimal'
        : safeExit > currentExit ? 'increase'
        : 'decrease';

      analysis[instrument] = {
        instrument,
        tradeCount: trades.length,
        currentExit,
        safeExit,
        safeExitPct,
        winRateAtSafe,
        winRateAtCurrent,
        hitsAtCurrent,
        direction,
      };
    }

    return NextResponse.json(analysis);
  } catch (e) {
    console.error('Profit analysis error:', e);
    return NextResponse.json({ error: 'Failed to analyse' }, { status: 500 });
  }
}
