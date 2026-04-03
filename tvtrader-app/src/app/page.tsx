'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Header from '../components/Header';
import ModeToggle from '../components/ModeToggle';

interface AccountData {
  balance: string;
  nav: string;
  marginAvailable: string;
  unrealizedPL: string;
  currency: string;
  openTradeCount: number;
}

interface Trade {
  id: number;
  broker_trade_id: string;
  instrument: string;
  direction: 'buy' | 'sell';
  units: string;
  notional_account_ccy: string | null;
  leverage_used: number | null;
  entry_price: string;
  tp_price: string;
  sl_price: string;
  spread_at_entry: string;
  slippage_pips: string;
  status: string;
  highest_price: string | null;
  lowest_price: string | null;
  highest_price_time: string | null;
  lowest_price_time: string | null;
  realized_pl: string | null;
  close_price: string | null;
  closed_at: string | null;
  created_at: string;
  current_price?: string;
  current_pl?: string;
  current_pl_pct?: string;
  potential_profit?: string;
  potential_profit_pct?: string;
  potential_loss?: string;
  potential_loss_pct?: string;
  spread_cost?: string;
  peak_pl?: string | null;
  trough_pl?: string | null;
  profit_exit_price?: string | null;
  effective_profit_target?: string | null;
  loss_exit_price?: string | null;
  effective_loss_target?: string | null;
}

function AccountCards({ data }: { data: AccountData | null }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 lg:gap-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-card border border-card-border rounded-lg p-4 lg:p-6 animate-pulse">
            <div className="h-3 bg-card-border rounded w-16 mb-2" />
            <div className="h-6 bg-card-border rounded w-24" />
          </div>
        ))}
      </div>
    );
  }
  const items = [
    { label: 'Balance', value: parseFloat(data.balance).toFixed(2), suffix: data.currency },
    { label: 'Available Margin', value: parseFloat(data.marginAvailable).toFixed(2), suffix: data.currency },
    { label: 'Unrealized P/L', value: parseFloat(data.unrealizedPL).toFixed(2), suffix: data.currency, color: parseFloat(data.unrealizedPL) >= 0 ? 'text-green' : 'text-red' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 lg:gap-5">
      {items.map((item) => (
        <div key={item.label} className="bg-card border border-card-border rounded-lg p-4 lg:p-6">
          <p className="text-xs lg:text-sm text-muted uppercase tracking-wider mb-1 lg:mb-2">{item.label}</p>
          <p className={`text-xl lg:text-2xl 2xl:text-3xl font-semibold tabular-nums ${item.color || ''}`}>
            {item.value}<span className="text-xs lg:text-sm text-muted ml-1">{item.suffix}</span>
          </p>
        </div>
      ))}
    </div>
  );
}

function PerformanceSummary({ trades, account, initialBalance, sym }: { trades: Trade[]; account: AccountData | null; initialBalance: number; sym: string }) {
  const closed = trades.filter((t) => t.status !== 'open');
  if (closed.length === 0) return null;
  const netPL = account && initialBalance > 0
    ? parseFloat(account.balance) - initialBalance
    : closed.reduce((sum, t) => sum + parseFloat(t.realized_pl || '0'), 0);
  const netPLPct = initialBalance > 0 ? netPL / initialBalance * 100 : null;
  const wins = closed.filter((t) => parseFloat(t.realized_pl || '0') > 0);
  const losses = closed.filter((t) => parseFloat(t.realized_pl || '0') < 0);
  const winRate = Math.round(wins.length / closed.length * 100);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + parseFloat(t.realized_pl || '0'), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + parseFloat(t.realized_pl || '0'), 0) / losses.length : 0;
  return (
    <div className="bg-card border border-card-border rounded-lg px-6 py-4 lg:px-8">
      <div className="flex flex-wrap gap-3 lg:gap-6 items-center">
        <div>
          <p className="text-xs text-muted mb-0.5">Net P/L</p>
          <p className={`text-xl font-bold tabular-nums ${netPL >= 0 ? 'text-green' : 'text-red'}`}>
            {netPL >= 0 ? '+' : '-'}{sym}{Math.abs(netPL).toFixed(2)}
          </p>
          {netPLPct !== null && (
            <p className={`text-xs tabular-nums mt-0.5 ${netPL >= 0 ? 'text-green' : 'text-red'} opacity-70`}>
              {netPLPct >= 0 ? '+' : ''}{netPLPct.toFixed(2)}% of {sym}{initialBalance.toLocaleString()}
            </p>
          )}
        </div>
        <div className="w-px bg-card-border/50 self-stretch hidden sm:block" />
        <div><p className="text-xs text-muted mb-0.5">Win Rate</p><p className="text-xl font-bold tabular-nums">{winRate}%</p></div>
        <div><p className="text-xs text-muted mb-0.5">Wins</p><p className="text-xl font-bold tabular-nums text-green">{wins.length}</p></div>
        <div><p className="text-xs text-muted mb-0.5">Losses</p><p className="text-xl font-bold tabular-nums text-red">{losses.length}</p></div>
        <div className="w-px bg-card-border/50 self-stretch hidden sm:block" />
        <div><p className="text-xs text-muted mb-0.5">Avg Win</p><p className="text-xl font-bold tabular-nums text-green">+{sym}{avgWin.toFixed(2)}</p></div>
        <div><p className="text-xs text-muted mb-0.5">Avg Loss</p><p className="text-xl font-bold tabular-nums text-red">-{sym}{Math.abs(avgLoss).toFixed(2)}</p></div>
      </div>
    </div>
  );
}

function ActiveTradeCard({ trade, profitTarget, lossTarget, sym }: { trade: Trade; profitTarget?: number; lossTarget?: number; sym: string }) {
  const isBuy = trade.direction === 'buy';
  const currentPL = trade.current_pl ? parseFloat(trade.current_pl) : 0;
  const currentPLPct = trade.current_pl_pct ? parseFloat(trade.current_pl_pct) : 0;

  const highest = trade.highest_price ? parseFloat(trade.highest_price) : null;
  const lowest = trade.lowest_price ? parseFloat(trade.lowest_price) : null;
  const sl = parseFloat(trade.sl_price);
  const tp = parseFloat(trade.tp_price);
  const entry = parseFloat(trade.entry_price);
  const current = trade.current_price ? parseFloat(trade.current_price) : entry;
  const absUnits = Math.abs(parseFloat(trade.units));

  // Potential profit/loss come from /api/state (currency-converted to GBP).
  // They are cached in lastTradeDataRef so Phase 1 (fast DB poll) uses the last
  // converted value rather than falling back to a raw quote-currency calculation.
  const potProfit = trade.potential_profit ? parseFloat(trade.potential_profit) : 0;
  const potProfitPct = trade.potential_profit_pct ? parseFloat(trade.potential_profit_pct) : 0;
  const potLoss = trade.potential_loss ? parseFloat(trade.potential_loss) : 0;
  const potLossPct = trade.potential_loss_pct ? parseFloat(trade.potential_loss_pct) : 0;
  const spreadCost = trade.spread_cost
    ? parseFloat(trade.spread_cost)
    : trade.spread_at_entry ? parseFloat(trade.spread_at_entry) * absUnits : 0;

  const range = isBuy ? tp - sl : sl - tp;
  const toPos = (p: number) => Math.max(0, Math.min(100, isBuy ? (p - sl) / range * 100 : (sl - p) / range * 100));

  const curPos = toPos(current);
  const entryPos = toPos(entry);
  const highPos = highest !== null ? toPos(highest) : null;
  const lowPos = lowest !== null ? toPos(lowest) : null;
  const bandMin = highPos !== null && lowPos !== null ? Math.min(highPos, lowPos) : null;
  const bandWidth = highPos !== null && lowPos !== null ? Math.abs(highPos - lowPos) : null;
  const peakPos = isBuy ? highPos : lowPos;
  const troughPos = isBuy ? lowPos : highPos;
  const profitExitPos = trade.profit_exit_price
    ? toPos(parseFloat(trade.profit_exit_price))
    : null;
  const lossExitPos = trade.loss_exit_price
    ? toPos(parseFloat(trade.loss_exit_price))
    : null;

  const barColor = curPos >= 66 ? 'rgba(34,197,94,0.7)' : curPos >= 33 ? 'rgba(234,179,8,0.7)' : 'rgba(239,68,68,0.7)';

  // Peak/trough P/L come pre-converted to GBP from /api/state
  const peakPL = trade.peak_pl != null ? parseFloat(trade.peak_pl as string) : null;
  const troughPL = trade.trough_pl != null ? parseFloat(trade.trough_pl as string) : null;

  // Bar label helpers
  const fmtTime = (ts: string | null | undefined): string | null => {
    if (!ts) return null;
    try { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
    catch { return null; }
  };
  const clampPos = (p: number) => Math.max(3, Math.min(94, Math.round(p)));
  const isReduced = !!(trade.effective_profit_target && profitTarget &&
    parseFloat(trade.effective_profit_target) < profitTarget);
  const isLossReduced = !!(trade.effective_loss_target && lossTarget &&
    parseFloat(trade.effective_loss_target) < lossTarget);
  // highPL = P/L at the highest-price marker; lowPL = P/L at the lowest-price marker
  const highPL = isBuy ? peakPL : troughPL;
  const lowPL  = isBuy ? troughPL : peakPL;
  const highTime = fmtTime(trade.highest_price_time);
  const lowTime  = fmtTime(trade.lowest_price_time);

  type BarLabel = { pos: number; text: string; subtext?: string; colorClass: string };

  const aboveLabels: BarLabel[] = [
    ...(profitExitPos !== null && (trade.effective_profit_target || profitTarget) ? [{
      pos: profitExitPos,
      text: `${isReduced ? 'Reduced Exit' : 'Exit'} ${sym}${trade.effective_profit_target ?? profitTarget}`,
      colorClass: isReduced ? 'text-orange-400' : 'text-accent',
    }] : []),
    ...(lossExitPos !== null && (trade.effective_loss_target || lossTarget) ? [{
      pos: lossExitPos,
      text: `${isLossReduced ? 'Reduced Loss Exit' : 'Loss Exit'} -${sym}${trade.effective_loss_target ?? lossTarget}`,
      colorClass: isLossReduced ? 'text-orange-400' : 'text-red',
    }] : []),
    ...(highPos !== null && highPL !== null ? [{
      pos: highPos,
      text: `High ${highPL >= 0 ? '+' : '-'}${sym}${Math.abs(highPL).toFixed(2)}`,
      subtext: highTime ?? undefined,
      colorClass: highPL >= 0 ? 'text-green' : 'text-red',
    }] : []),
    { pos: entryPos, text: `Entry ${parseFloat(trade.entry_price).toFixed(5)}`, colorClass: 'text-white/50' },
  ];

  const belowLabels: BarLabel[] = [
    ...(lowPos !== null && lowPL !== null ? [{
      pos: lowPos,
      text: `Low ${lowPL >= 0 ? '+' : '-'}${sym}${Math.abs(lowPL).toFixed(2)}`,
      subtext: lowTime ?? undefined,
      colorClass: lowPL >= 0 ? 'text-green' : 'text-red',
    }] : []),
  ];

  const assignBarRows = (labels: BarLabel[]): number[] => {
    const rows = new Array<number>(labels.length).fill(0);
    if (labels.length === 0) return rows;
    const sorted = labels.map((l, i) => ({ i, pos: l.pos })).sort((a, b) => a.pos - b.pos);
    const rowTail: number[] = [-Infinity];
    for (const { i, pos } of sorted) {
      let placed = false;
      for (let r = 0; r < rowTail.length; r++) {
        if (pos - rowTail[r] >= 13) { rows[i] = r; rowTail[r] = pos; placed = true; break; }
      }
      if (!placed) { rows[i] = rowTail.length; rowTail.push(pos); }
    }
    return rows;
  };

  const aboveRows = assignBarRows(aboveLabels);
  const belowRows = assignBarRows(belowLabels);
  const numAboveRows = aboveLabels.length ? Math.max(...aboveRows) + 1 : 0;
  const numBelowRows = belowLabels.length ? Math.max(...belowRows) + 1 : 0;
  const barLabelRowH = 1.8; // em per row (accommodates optional subtext line)

  return (
    <div className="bg-background/40 border border-card-border/60 rounded-lg p-4 lg:p-6">
      <div className="flex items-center justify-between mb-4 lg:mb-6">
        <h2 className="text-sm lg:text-base font-medium text-muted uppercase tracking-wider">{trade.instrument.replace('_', '/')}</h2>
        <span className={`text-xs lg:text-sm font-bold px-2 py-0.5 lg:px-3 lg:py-1 rounded ${isBuy ? 'bg-green/15 text-green' : 'bg-red/15 text-red'}`}>
          {isBuy ? 'LONG' : 'SHORT'}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 lg:gap-6 mb-4 lg:mb-6">
        {[
          { label: 'Entry Price', value: parseFloat(trade.entry_price).toFixed(5) },
          { label: 'Stop Loss', value: parseFloat(trade.sl_price).toFixed(5), color: 'text-red' },
          { label: 'Take Profit', value: parseFloat(trade.tp_price).toFixed(5), color: 'text-green' },
          {
            label: 'Units',
            value: (() => {
              const units = Math.abs(parseFloat(trade.units)).toLocaleString();
              const margin = trade.notional_account_ccy ? `${sym}${parseFloat(trade.notional_account_ccy).toFixed(0)}` : null;
              const lev = trade.leverage_used;
              const notional = margin && lev ? `${sym}${(parseFloat(trade.notional_account_ccy!) * lev).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : null;
              return units + (margin ? ` · ${margin} margin${notional && lev && lev > 1 ? ` · ${notional} notional (${lev}×)` : ''}` : '');
            })(),
          },
          { label: 'Current Price', value: trade.current_price || '—' },
          { label: 'Spread at Entry', value: trade.spread_at_entry || '—' },
          {
            label: 'Slippage',
            value: trade.slippage_pips ? `${parseFloat(trade.slippage_pips) > 0 ? '+' : ''}${trade.slippage_pips} pips` : '—',
            color: trade.slippage_pips ? (parseFloat(trade.slippage_pips) > 0 ? 'text-red' : parseFloat(trade.slippage_pips) < 0 ? 'text-green' : '') : '',
          },
          {
            label: 'Peak P/L',
            value: peakPL !== null ? `${peakPL >= 0 ? '+' : '-'}${sym}${Math.abs(peakPL).toFixed(2)}` : '—',
            color: peakPL !== null ? (peakPL >= 0 ? 'text-green' : 'text-red') : 'text-muted',
          },
          {
            label: 'Max Drawdown',
            value: troughPL !== null ? `${troughPL >= 0 ? '+' : '-'}${sym}${Math.abs(troughPL).toFixed(2)}` : '—',
            color: troughPL !== null ? (troughPL >= 0 ? 'text-green' : 'text-red') : 'text-muted',
          },
        ].map((item) => (
          <div key={item.label}>
            <p className="text-xs lg:text-sm text-muted mb-0.5 lg:mb-1">{item.label}</p>
            <p className={`text-sm lg:text-base font-semibold tabular-nums ${item.color || ''}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div className="mb-4 lg:mb-6">
        <div className="flex justify-between items-center text-xs mb-1.5">
          <span className="text-red font-mono tabular-nums">SL {parseFloat(trade.sl_price).toFixed(5)}</span>
          <span className="text-muted">{curPos.toFixed(1)}% from SL · {(100 - curPos).toFixed(1)}% to TP</span>
          <span className="text-green font-mono tabular-nums">TP {parseFloat(trade.tp_price).toFixed(5)}</span>
        </div>
        {/* Above-bar label zone — rows assigned dynamically to prevent overlap */}
        {numAboveRows > 0 && (
          <div className="relative" style={{ height: `${numAboveRows * barLabelRowH}em`, marginBottom: '0.3em' }}>
            {aboveLabels.map((label, i) => (
              <div key={i}
                className={`absolute text-xs font-semibold whitespace-nowrap pointer-events-none ${label.colorClass}`}
                style={{
                  bottom: `${aboveRows[i] * barLabelRowH}em`,
                  left: `${clampPos(label.pos)}%`,
                  transform: 'translate3d(-50%,0,0)',
                  WebkitFontSmoothing: 'antialiased',
                  lineHeight: 1.25,
                  textAlign: 'center',
                }}>
                <div>{label.text}</div>
                {label.subtext && <div style={{ fontSize: '0.7rem', opacity: 0.65, textAlign: 'center' }}>{label.subtext}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Bar */}
        <div className="relative h-4 bg-muted/15 rounded-full overflow-hidden">
          <div className="absolute inset-0 rounded-full" style={{ background: 'linear-gradient(to right,rgba(239,68,68,0.12),rgba(234,179,8,0.08),rgba(34,197,94,0.12))' }} />
          {bandMin !== null && bandWidth !== null && (
            <div className="absolute inset-y-0 bg-white/10 rounded-sm" style={{ left: `${bandMin}%`, width: `${bandWidth}%` }} />
          )}
          <div className="absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500" style={{ width: `${curPos}%`, backgroundColor: barColor }} />
          <div className="absolute inset-y-0 w-1 bg-white/40 rounded-sm" style={{ left: `${entryPos}%` }} />
          {lowPos !== null && <div className="absolute inset-y-0 w-1 bg-red/80 rounded-sm" style={{ left: `${lowPos}%` }} />}
          {highPos !== null && <div className="absolute inset-y-0 w-1 bg-green/80 rounded-sm" style={{ left: `${highPos}%` }} />}
          {profitExitPos !== null && (
            <div className={`absolute inset-y-0 w-1 rounded-sm ${isReduced ? 'bg-orange-400/70' : 'bg-accent/80'}`} style={{ left: `${profitExitPos}%` }} />
          )}
          {lossExitPos !== null && (
            <div className={`absolute inset-y-0 w-1 rounded-sm ${isLossReduced ? 'bg-orange-400/70' : 'bg-red/80'}`} style={{ left: `${lossExitPos}%` }} />
          )}
          <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 border-white/80 transition-[left,background-color] duration-500"
            style={{ left: `calc(${curPos}% - 5px)`, backgroundColor: barColor, boxShadow: `0 0 6px ${barColor}` }} />
        </div>

        {/* Below-bar label zone */}
        {numBelowRows > 0 && (
          <div className="relative" style={{ height: `${numBelowRows * barLabelRowH}em`, marginTop: '0.3em' }}>
            {belowLabels.map((label, i) => (
              <div key={i}
                className={`absolute text-xs font-semibold whitespace-nowrap pointer-events-none ${label.colorClass}`}
                style={{
                  top: `${belowRows[i] * barLabelRowH}em`,
                  left: `${clampPos(label.pos)}%`,
                  transform: 'translate3d(-50%,0,0)',
                  WebkitFontSmoothing: 'antialiased',
                  lineHeight: 1.25,
                  textAlign: 'center',
                }}>
                <div>{label.text}</div>
                {label.subtext && <div style={{ fontSize: '0.7rem', opacity: 0.65, textAlign: 'center' }}>{label.subtext}</div>}
              </div>
            ))}
          </div>
        )}
        {(lowest !== null || highest !== null) && (
          <div className="flex justify-between text-xs mt-1 text-muted/60">
            <span className={lowest !== null ? (isBuy ? 'text-red/60' : 'text-green/60') : ''}>
              {lowest !== null ? `Low ${parseFloat(trade.lowest_price!).toFixed(5)}` : ''}
            </span>
            <span className={highest !== null ? (isBuy ? 'text-green/60' : 'text-red/60') : ''}>
              {highest !== null ? `High ${parseFloat(trade.highest_price!).toFixed(5)}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* P/L footer */}
      <div className="border-t border-card-border pt-4 lg:pt-6 grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
        <div>
          <p className="text-xs lg:text-sm text-muted mb-0.5 lg:mb-1">Current P/L</p>
          <p className={`text-lg lg:text-xl 2xl:text-2xl font-bold tabular-nums ${currentPL >= 0 ? 'text-green' : 'text-red'}`}>
            {currentPL >= 0 ? '+' : '-'}{sym}{Math.abs(currentPL).toFixed(2)}
            <span className="text-xs lg:text-sm ml-1">({currentPLPct >= 0 ? '+' : ''}{currentPLPct.toFixed(2)}%)</span>
          </p>
        </div>
        <div>
          <p className="text-xs lg:text-sm text-muted mb-0.5 lg:mb-1">Profit if TP Hit</p>
          <p className="text-lg lg:text-xl 2xl:text-2xl font-bold tabular-nums text-green">
            +{sym}{potProfit.toFixed(2)}<span className="text-xs lg:text-sm ml-1">(+{potProfitPct.toFixed(2)}%)</span>
          </p>
        </div>
        <div>
          <p className="text-xs lg:text-sm text-muted mb-0.5 lg:mb-1">Loss if SL Hit</p>
          <p className="text-lg lg:text-xl 2xl:text-2xl font-bold tabular-nums text-red">
            -{sym}{Math.abs(potLoss).toFixed(2)}<span className="text-xs lg:text-sm ml-1">({potLossPct.toFixed(2)}%)</span>
          </p>
        </div>
        <div>
          <p className="text-xs lg:text-sm text-muted mb-0.5 lg:mb-1">Spread Cost</p>
          <p className="text-lg lg:text-xl 2xl:text-2xl font-bold tabular-nums text-muted">{spreadCost.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}

function ActiveTradesSection({ trades, profitTargets, lossTargets, sym }: { trades: Trade[]; profitTargets: Record<string, number>; lossTargets: Record<string, number>; sym: string }) {
  const open = trades.filter((t) => t.status === 'open');
  return (
    <div className="bg-card border border-card-border rounded-lg p-6 lg:p-8">
      <h2 className="text-sm lg:text-base font-medium text-muted uppercase tracking-wider mb-4 lg:mb-6">
        Active Trades
        {open.length > 0 && (
          <span className="ml-2 text-xs font-normal text-accent bg-accent/10 px-1.5 py-0.5 rounded">{open.length}</span>
        )}
      </h2>
      {open.length === 0 ? (
        <div className="flex items-center justify-center py-8 lg:py-12">
          <div className="text-center">
            <div className="w-3 h-3 rounded-full bg-muted/30 mx-auto mb-3 animate-pulse" />
            <p className="text-muted text-sm lg:text-base">No active trades — waiting for signal</p>
          </div>
        </div>
      ) : (
        <div className={open.length > 1 ? 'grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6' : ''}>
          {open.map((trade) => <ActiveTradeCard key={trade.id} trade={trade} profitTarget={profitTargets[trade.instrument]} lossTarget={lossTargets[trade.instrument]} sym={sym} />)}
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  tp_hit: { text: 'TP Hit', color: 'text-green' },
  sl_hit: { text: 'SL Hit', color: 'text-red' },
  exited: { text: 'Profit Exit', color: 'text-accent' },
  exited_no_tp: { text: 'No TP', color: 'text-red' },
  exited_no_sl: { text: 'No SL', color: 'text-red' },
  open: { text: 'Open', color: 'text-muted' },
};

function fmtPrice(v: string | null) { return v ? parseFloat(v).toFixed(5) : '—'; }

function elapsed(from: string, to: string | null | undefined) {
  if (!to) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs === 0 ? `${mins % 60}m` : `${hrs}h ${mins % 60}m`;
}

function MiniBar({ trade }: { trade: Trade }) {
  const isBuy = trade.direction === 'buy';
  const sl = parseFloat(trade.sl_price);
  const tp = parseFloat(trade.tp_price);
  const entry = parseFloat(trade.entry_price);
  const range = isBuy ? tp - sl : sl - tp;
  if (range <= 0) return null;
  const toPos = (p: number) => Math.max(0, Math.min(100, isBuy ? (p - sl) / range * 100 : (sl - p) / range * 100));

  const entryPos = toPos(entry);
  const closePos = trade.close_price ? toPos(parseFloat(trade.close_price)) : null;
  const worstRef = isBuy ? trade.lowest_price : trade.highest_price;
  const bestRef = isBuy ? trade.highest_price : trade.lowest_price;
  const worstPos = worstRef ? toPos(parseFloat(worstRef)) : null;
  const bestPos = bestRef ? toPos(parseFloat(bestRef)) : null;
  const bandMin = worstPos !== null && bestPos !== null ? Math.min(worstPos, bestPos) : null;
  const bandWidth = worstPos !== null && bestPos !== null ? Math.abs(bestPos - worstPos) : null;
  const isTP = trade.status === 'tp_hit';
  const isSL = trade.status === 'sl_hit';

  return (
    <div className="px-2 pb-3 pt-0.5">
      <div className="flex justify-between text-[10px] tabular-nums select-none mb-0.5">
        <span className="text-red/50">SL {fmtPrice(trade.sl_price)}</span>
        <span className="text-green/50">TP {fmtPrice(trade.tp_price)}</span>
      </div>
      <div className="relative h-5 bg-muted/10 rounded-full overflow-hidden">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to right,rgba(239,68,68,0.1),rgba(234,179,8,0.05),rgba(34,197,94,0.1))' }} />
        {bandMin !== null && bandWidth !== null && (
          <div className="absolute inset-y-0 bg-white/[0.07]" style={{ left: `${bandMin}%`, width: `${bandWidth}%` }} />
        )}
        <div className="absolute inset-y-0 w-px bg-white/35" style={{ left: `${entryPos}%` }} />
        {worstPos !== null && <div className="absolute inset-y-0 w-px bg-red/50" style={{ left: `${worstPos}%` }} />}
        {bestPos !== null && <div className="absolute inset-y-0 w-px bg-green/50" style={{ left: `${bestPos}%` }} />}
        {closePos !== null && (
          <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border border-white/50 z-10"
            style={{ left: `calc(${closePos}% - 5px)`, backgroundColor: isTP ? 'rgba(34,197,94,0.5)' : isSL ? 'rgba(239,68,68,0.5)' : 'rgba(148,163,184,0.35)' }} />
        )}
      </div>
      {(worstPos !== null || bestPos !== null) && (
        <div className="flex gap-3 text-[10px] mt-0.5 tabular-nums select-none">
          {worstPos !== null && <span className="text-red/50">MAE −{Math.abs(worstPos - entryPos).toFixed(0)}%</span>}
          {bestPos !== null && <span className="text-green/50">MFE +{Math.abs(bestPos - entryPos).toFixed(0)}%</span>}
        </div>
      )}
    </div>
  );
}

function TradeHistory({ trades, onDelete, onClearAll, sym }: { trades: Trade[]; onDelete: (id: number) => void; onClearAll: () => void; sym: string }) {
  const closed = trades.filter((t) => t.status !== 'open');
  if (closed.length === 0) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-6 lg:p-8">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-4">Trade History</h2>
        <p className="text-muted text-sm text-center py-8">No trades yet</p>
      </div>
    );
  }
  return (
    <div className="bg-card border border-card-border rounded-lg p-6 lg:p-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">Trade History</h2>
        <button onClick={onClearAll} className="text-xs text-red hover:text-red/80 transition-colors">Clear All</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase border-b border-card-border">
              <th className="text-left py-2 pr-3">Pair</th>
              <th className="text-left py-2 pr-3">Dir</th>
              <th className="text-right py-2 pr-3">Entry</th>
              <th className="text-right py-2 pr-3">Close</th>
              <th className="text-right py-2 pr-3" title="Worst P/L in session">Low {sym}</th>
              <th className="text-right py-2 pr-3" title="Best P/L in session">High {sym}</th>
              <th className="text-right py-2 pr-3">Slip</th>
              <th className="text-right py-2 pr-3 text-foreground font-semibold">P/L</th>
              <th className="text-left py-2 pr-3">Status</th>
              <th className="text-left py-2 pr-3">Date</th>
              <th className="w-8 py-2" />
            </tr>
          </thead>
          <tbody>
            {closed.map((trade) => {
              const pl = parseFloat(trade.realized_pl || '0');
              const label = STATUS_LABELS[trade.status] || { text: trade.status, color: 'text-muted' };
              const isBuy = trade.direction === 'buy';
              // peak_pl / trough_pl are GBP-converted values from /api/trades enrichment
              const worstPL = trade.trough_pl != null ? parseFloat(trade.trough_pl as string) : null;
              const bestPL = trade.peak_pl != null ? parseFloat(trade.peak_pl as string) : null;
              const worstTime = elapsed(trade.created_at, isBuy ? trade.lowest_price_time : trade.highest_price_time);
              const bestTime = elapsed(trade.created_at, isBuy ? trade.highest_price_time : trade.lowest_price_time);
              return (
                <>
                  <tr key={trade.id} className="border-t border-card-border/30 hover:bg-white/[0.02]">
                    <td className="pt-2.5 pb-1 pr-3 font-medium">{trade.instrument.replace('_', '/')}</td>
                    <td className="pt-2.5 pb-1 pr-3 text-xs">
                      <span className={isBuy ? 'text-green' : 'text-red'}>{isBuy ? 'LONG' : 'SHORT'}</span>
                    </td>
                    <td className="pt-2.5 pb-1 pr-3 text-right tabular-nums">{fmtPrice(trade.entry_price)}</td>
                    <td className="pt-2.5 pb-1 pr-3 text-right tabular-nums">{fmtPrice(trade.close_price)}</td>
                    <td className={`pt-2.5 pb-1 pr-3 text-right tabular-nums text-xs ${worstPL !== null ? worstPL >= 0 ? 'text-green' : 'text-red' : 'text-muted'}`}>
                      {worstPL !== null ? `${worstPL >= 0 ? '+' : '-'}${sym}${Math.abs(worstPL).toFixed(2)}` : '—'}
                      {worstTime ? <span className="block text-[10px] text-muted/60">{worstTime}</span> : null}
                    </td>
                    <td className={`pt-2.5 pb-1 pr-3 text-right tabular-nums text-xs ${bestPL !== null ? bestPL >= 0 ? 'text-green' : 'text-red' : 'text-muted'}`}>
                      {bestPL !== null ? `${bestPL >= 0 ? '+' : '-'}${sym}${Math.abs(bestPL).toFixed(2)}` : '—'}
                      {bestTime ? <span className="block text-[10px] text-muted/60">{bestTime}</span> : null}
                    </td>
                    <td className={`pt-2.5 pb-1 pr-3 text-right tabular-nums text-xs ${trade.slippage_pips ? parseFloat(trade.slippage_pips) > 0 ? 'text-red' : parseFloat(trade.slippage_pips) < 0 ? 'text-green' : 'text-muted' : 'text-muted'}`}>
                      {trade.slippage_pips ? `${parseFloat(trade.slippage_pips) > 0 ? '+' : ''}${parseFloat(trade.slippage_pips).toFixed(1)}p` : '—'}
                    </td>
                    <td className="pt-2.5 pb-1 pr-3 text-right">
                      <span className={`text-base font-bold tabular-nums ${pl >= 0 ? 'text-green' : 'text-red'}`}>
                        {pl >= 0 ? '+' : '-'}{sym}{Math.abs(pl).toFixed(2)}
                      </span>
                    </td>
                    <td className={`pt-2.5 pb-1 pr-3 text-sm ${label.color}`}>{label.text}</td>
                    <td className="pt-2.5 pb-1 pr-3 text-muted tabular-nums text-xs">
                      {new Date(trade.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="pt-2.5 pb-1 text-center">
                      <button onClick={() => onDelete(trade.id)} className="text-muted hover:text-red transition-colors p-0.5" title="Delete">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02]">
                    <td colSpan={11} className="p-0 pb-0.5">
                      <MiniBar trade={trade} />
                    </td>
                  </tr>
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [activeTrades, setActiveTrades] = useState<Trade[]>([]);
  const [allTrades, setAllTrades] = useState<Trade[]>([]);
  const [tradingMode, setTradingMode] = useState('practice');
  const [profitTargets, setProfitTargets] = useState<Record<string, number>>({});
  const [lossTargets, setLossTargets] = useState<Record<string, number>>({});
  const [currencySymbol, setCurrencySymbol] = useState('£');
  const [initialBalance, setInitialBalance] = useState<number>(0);
  const activeCountRef = useRef(0);
  activeCountRef.current = activeTrades.length;
  // Retain last known enrichment fields so a stale OANDA poll doesn't blank them out
  const lastTradeDataRef = useRef<Record<string, Partial<Trade>>>({});
  // Ref to allTrades for stable closure access in refresh()
  const allTradesRef = useRef<Trade[]>([]);

  const refresh = useCallback(async () => {
    try {
      // Fire all requests simultaneously — no extra network overhead
      const acctFetch     = fetch('/api/account');
      const stateFetch    = fetch('/api/state');
      const tradesFetch   = fetch('/api/trades');
      const settingsFetch = fetch('/api/settings');

      // Phase 1 (fast ~200ms): /api/trades is DB-only — process it immediately
      // so the card appears without waiting for OANDA (/api/state can take 5-15s)
      const tradesRes = await tradesFetch;
      if (tradesRes.ok) {
        const tradesData = await tradesRes.json();
        allTradesRef.current = tradesData.trades || [];
        setAllTrades(allTradesRef.current);
        const dbOpenTrades = allTradesRef.current.filter((t) => t.status === 'open');
        // Show card immediately using DB data + last cached enrichment
        setActiveTrades(dbOpenTrades.map((dbTrade) => ({
          ...dbTrade,
          ...(lastTradeDataRef.current[dbTrade.broker_trade_id] || {}),
        })));
      }

      // Phase 2 (slow): OANDA enrichment + account + settings
      const [acctRes, stateRes, settingsRes] = await Promise.all([acctFetch, stateFetch, settingsFetch]);

      if (acctRes.ok) setAccount(await acctRes.json());

      const stateData = stateRes.ok ? await stateRes.json() : null;

      // DB open trades (re-derive in case Phase 1 hadn't completed yet)
      const dbOpenTrades: Trade[] = allTradesRef.current.filter((t) => t.status === 'open');

      const stateActive: Trade[] = stateData?.active
        ? (stateData.trades || (stateData.trade ? [stateData.trade] : []))
        : [];
      const stateById = new Map(stateActive.map((t: Trade) => [t.broker_trade_id, t]));

      const enrichmentKeys: (keyof Trade)[] = ['current_pl', 'current_pl_pct', 'current_price', 'potential_profit', 'potential_profit_pct', 'potential_loss', 'potential_loss_pct', 'peak_pl', 'trough_pl', 'profit_exit_price', 'effective_profit_target', 'loss_exit_price', 'effective_loss_target'];
      const merged = dbOpenTrades.map((dbTrade) => {
        const enriched = stateById.get(dbTrade.broker_trade_id);
        if (enriched) {
          lastTradeDataRef.current[dbTrade.broker_trade_id] = {
            ...lastTradeDataRef.current[dbTrade.broker_trade_id],
            ...Object.fromEntries(
              enrichmentKeys.filter((k) => enriched[k] !== undefined).map((k) => [k, enriched[k]])
            ),
          };
          return enriched;
        }
        // OANDA blip — card stays with DB data + last cached P&L
        return { ...dbTrade, ...(lastTradeDataRef.current[dbTrade.broker_trade_id] || {}) };
      });

      setActiveTrades(merged);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setTradingMode(data.trading_mode || 'practice');
        const ib = parseFloat(data.initial_balance || '0');
        if (ib > 0) setInitialBalance(ib);
        const targets: Record<string, number> = {};
        const lTargets: Record<string, number> = {};
        for (const key of Object.keys(data)) {
          if (key.startsWith('profit_target_')) {
            const instrument = key.replace('profit_target_', '');
            const val = parseFloat(data[key] || '0');
            if (val > 0) targets[instrument] = val;
          }
          if (key.startsWith('loss_target_')) {
            const instrument = key.replace('loss_target_', '');
            const val = parseFloat(data[key] || '0');
            if (val > 0) lTargets[instrument] = val;
          }
        }
        setProfitTargets(targets);
        setLossTargets(lTargets);
        const sym: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', AUD: 'A$', CAD: 'C$', CHF: 'Fr' };
        setCurrencySymbol(sym[data.account_currency || 'GBP'] ?? '£');
      }
    } catch (e) {
      console.error('Failed to fetch data:', e);
    }
  }, []); // stable — all mutable state goes through refs

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, activeCountRef.current > 0 ? 1000 : 8000);
    };
    refresh().then(() => schedule());
    return () => clearTimeout(timer);
  }, [refresh]);

  const deleteTrade = async (id: number) => {
    try {
      await fetch('/api/trades', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      refresh();
    } catch (e) { console.error('Failed to delete trade:', e); }
  };

  const clearAll = async () => {
    try {
      await fetch('/api/trades', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
      refresh();
    } catch (e) { console.error('Failed to clear trades:', e); }
  };

  const toggleMode = async (mode: string) => {
    try {
      const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trading_mode: mode }) });
      if (res.ok) { setTradingMode(mode); refresh(); }
    } catch (e) { console.error('Failed to update mode:', e); }
  };

  // Update browser tab title with live P&L
  useEffect(() => {
    if (activeTrades.length === 0) {
      document.title = 'TV Trader';
      return;
    }
    const parts = activeTrades.map((t) => {
      const pair = t.instrument.replace('_', '/');
      const pl = t.current_pl ? parseFloat(t.current_pl) : null;
      if (pl === null) return pair;
      const sign = pl >= 0 ? '+' : '-';
      return `${pair}: ${sign}${currencySymbol}${Math.abs(pl).toFixed(2)}`;
    });
    document.title = parts.join(' · ') + ' | TV Trader';
  }, [activeTrades]);

  // Merge active state trades with allTrades for display
  const mergedTrades: Trade[] = [
    ...activeTrades,
    ...allTrades.filter((t) => t.status !== 'open'),
  ];

  return (
    <>
      <Header />
      <main className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg lg:text-xl font-semibold">Dashboard</h2>
            <p className="text-xs lg:text-sm text-muted mt-0.5">
              {tradingMode === 'live'
                ? <span className="text-red font-medium">LIVE TRADING</span>
                : <span className="text-accent">Paper Trading</span>}
            </p>
          </div>
          <ModeToggle mode={tradingMode} onToggle={toggleMode} />
        </div>
        <AccountCards data={account} />
        <PerformanceSummary trades={allTrades} account={account} initialBalance={initialBalance} sym={currencySymbol} />
        <ActiveTradesSection trades={activeTrades} profitTargets={profitTargets} lossTargets={lossTargets} sym={currencySymbol} />
        <TradeHistory trades={mergedTrades} onDelete={deleteTrade} onClearAll={clearAll} sym={currencySymbol} />
      </main>
    </>
  );
}
