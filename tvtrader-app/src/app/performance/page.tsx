'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from '../../components/Header';

interface Trade {
  id: number;
  instrument: string;
  direction: string;
  realized_pl: string | null;
  closed_at: string | null;
  created_at: string;
  status: string;
  entry_price: string;
  tp_price: string;
  sl_price: string;
  units: string;
}

const PAIRS = ['EUR_USD', 'XAU_USD', 'NZD_JPY'] as const;
const COLORS: Record<string, string> = {
  ALL: '#0ecb81', EUR_USD: '#f0b90b', XAU_USD: '#3b82f6', NZD_JPY: '#a855f7',
};
const LABELS: Record<string, string> = {
  ALL: 'All Pairs', EUR_USD: 'EUR/USD', XAU_USD: 'XAU/USD', NZD_JPY: 'NZD/JPY',
};

function buildSeries(trades: Trade[], instrument?: string) {
  const filtered = instrument ? trades.filter(t => t.instrument === instrument) : trades;
  const sorted = [...filtered]
    .filter(t => t.closed_at && t.realized_pl != null)
    .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
  let cum = 0;
  return sorted.map(t => {
    cum += parseFloat(t.realized_pl || '0');
    return { time: new Date(t.closed_at!).getTime(), cumPL: cum, trade: t };
  });
}

function niceStep(range: number, steps = 6) {
  const rough = range / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 0.01))));
  return [1, 2, 5, 10].map(f => f * mag).find(s => s >= rough) || mag * 10;
}

function fmtPL(v: number) {
  return v >= 0 ? `+£${v.toFixed(2)}` : `-£${Math.abs(v).toFixed(2)}`;
}
function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

const PAD = { top: 20, right: 24, bottom: 28, left: 64, bars: 60 };

export default function PerformancePage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [initialBalance, setInitialBalance] = useState<number>(0);
  const [currentNav, setCurrentNav] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>('ALL');
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 900, h: 360 });

  // Hover via refs to avoid re-renders on every mousemove
  const rafRef = useRef<number | null>(null);
  const mouseClientXRef = useRef(0);
  const hoverLineRef = useRef<SVGLineElement>(null);
  const hoverGroupRef = useRef<SVGGElement>(null);
  const hoverDataRef = useRef<{ allPoints: { time: number; cumPL: number; trade: Trade }[]; minT: number; maxT: number; chartW: number; seriesData: Record<string, { time: number; cumPL: number; trade: Trade }[]>; enabledKeys: string[] } | null>(null);

  useEffect(() => {
    fetch('/api/trades').then(r => r.json()).then(d => {
      const closed = (d.trades || []).filter((t: Trade) => t.status !== 'open' && t.closed_at);
      setTrades(closed);
    });
    fetch('/api/settings').then(r => r.json()).then(d => {
      const val = parseFloat(d.initial_balance || '0');
      if (val > 0) setInitialBalance(val);
    }).catch(() => {});
    fetch('/api/account').then(r => r.json()).then(d => {
      const nav = parseFloat(d.balance || '0');
      if (nav > 0) setCurrentNav(nav);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const el = entries[0];
      if (el) {
        const w = el.contentRect.width;
        setDims({ w, h: Math.max(300, w * 0.36) });
      }
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const select = (key: string) => setSelectedKey(key);

  const closed = useMemo(() =>
    trades
      .filter(t => t.closed_at && t.realized_pl != null)
      .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime()),
    [trades]);

  const seriesData = useMemo(() => ({
    ALL: buildSeries(closed),
    EUR_USD: buildSeries(closed, 'EUR_USD'),
    XAU_USD: buildSeries(closed, 'XAU_USD'),
    NZD_JPY: buildSeries(closed, 'NZD_JPY'),
  }), [closed]);

  const { totalPL, winRate, wins, maxDD } = useMemo(() => {
    const totalPL = closed.reduce((s, t) => s + parseFloat(t.realized_pl || '0'), 0);
    const wins = closed.filter(t => parseFloat(t.realized_pl || '0') > 0);
    const winRate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
    let peak = 0, cum = 0, maxDD = 0;
    for (const t of closed) {
      cum += parseFloat(t.realized_pl || '0');
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    }
    return { totalPL, wins, winRate, maxDD };
  }, [closed]);

  const chartH = dims.h - PAD.top - PAD.bottom - PAD.bars - 12;
  const chartW = dims.w - PAD.left - PAD.right;

  const { minT, maxT, yMin, yMax, yRange, yTicks, xTicks, paths, barInfo } = useMemo(() => {
    const allTimes = Object.values(seriesData).flat().map(p => p.time);
    const minT = allTimes.length > 0 ? Math.min(...allTimes) : 0;
    const maxT = allTimes.length > 0 ? Math.max(...allTimes) : 1;
    const allPLs = Object.values(seriesData).flat().map(p => p.cumPL);
    const minPL = Math.min(0, ...allPLs);
    const maxPL = Math.max(0, ...allPLs);
    const plRange = maxPL - minPL || 1;
    const step = niceStep(plRange);
    const yMin = Math.floor(minPL / step) * step;
    const yMax = Math.ceil(maxPL / step) * step;
    const yRange = yMax - yMin || 1;

    const tx = (t: number) => maxT > minT ? PAD.left + (t - minT) / (maxT - minT) * chartW : PAD.left;
    const ty = (v: number) => PAD.top + (1 - (v - yMin) / yRange) * chartH;

    const yTicks: number[] = [];
    for (let v = yMin; v <= yMax + step * 0.01; v += step) yTicks.push(Math.round(v * 100) / 100);

    const xTicks: number[] = [];
    if (allTimes.length > 1) {
      const n = Math.min(6, allTimes.length);
      for (let i = 0; i < n; i++) xTicks.push(minT + (maxT - minT) * i / (n - 1));
    } else if (allTimes.length === 1) xTicks.push(allTimes[0]);

    const paths: { key: string; d: string; fillD: string; color: string; endX: number; endY: number; endPL: number; dots: { x: number; y: number; win: boolean }[] }[] = [];
    // All Pairs: show each pair as its own coloured line (not the blended 'ALL' series)
    const keysToRender = selectedKey === 'ALL' ? ([...PAIRS] as string[]) : [selectedKey];
    for (const key of keysToRender) {
      const pts = seriesData[key as keyof typeof seriesData];
      if (!pts || pts.length === 0) continue;
      // Always start the line at (minT, 0) so single-trade pairs draw a visible line
      const x0 = tx(minT).toFixed(1);
      const y0 = ty(0).toFixed(1);
      const d = `M${x0},${y0} ` + pts.map(p => `L${tx(p.time).toFixed(1)},${ty(p.cumPL).toFixed(1)}`).join(' ');
      const last = pts[pts.length - 1];
      const fillD = `${d} L${tx(last.time).toFixed(1)},${ty(0).toFixed(1)} L${x0},${y0} Z`;
      const dots = pts.map(p => ({
        x: tx(p.time),
        y: ty(p.cumPL),
        win: parseFloat(p.trade.realized_pl || '0') >= 0,
      }));
      paths.push({ key, d, fillD, color: COLORS[key], endX: tx(last.time), endY: ty(last.cumPL), endPL: last.cumPL, dots });
    }

    const barY0 = PAD.top + chartH + 12;
    const barMaxH = PAD.bars - 8;
    const filteredForBars = selectedKey === 'ALL' ? closed : closed.filter(t => t.instrument === selectedKey);
    const barPLs = filteredForBars.map(t => Math.abs(parseFloat(t.realized_pl || '0')));
    const maxBarPL = Math.max(...barPLs, 0.01);
    const barInfo = filteredForBars.map(t => {
      const pl = parseFloat(t.realized_pl || '0');
      const bx = tx(new Date(t.closed_at!).getTime());
      const bw = Math.max(2, Math.min(12, chartW / Math.max(filteredForBars.length, 1) - 2));
      const bh = Math.max(1, Math.abs(pl) / maxBarPL * (barMaxH / 2));
      const by = pl >= 0 ? barY0 + barMaxH / 2 - bh : barY0 + barMaxH / 2;
      const color = pl >= 0 ? '#0ecb81' : '#f6465d';
      return { t, bx, bw, bh, by, color };
    });

    return { minT, maxT, yMin, yMax, yRange, yTicks, xTicks, paths, barInfo, tx, ty };
  }, [seriesData, closed, chartW, chartH, selectedKey]);

  // Keep hover data in ref for rAF handler
  useEffect(() => {
    const activePoints = selectedKey === 'ALL' ? seriesData.ALL : (seriesData[selectedKey as keyof typeof seriesData] || seriesData.ALL);
    const enabledKeys = selectedKey === 'ALL'
      ? (PAIRS as unknown as string[]).filter(k => seriesData[k as keyof typeof seriesData].length > 0)
      : (activePoints.length > 0 ? [selectedKey] : []);
    hoverDataRef.current = {
      allPoints: activePoints,
      minT, maxT, chartW,
      seriesData,
      enabledKeys,
    };
  }, [seriesData, minT, maxT, chartW, selectedKey]);

  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    // Capture raw client coords immediately — always use latest by the time RAF fires
    mouseClientXRef.current = e.clientX;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!hoverDataRef.current || !svgRef.current) return;
      // Use getScreenCTM inverse for accurate SVG-coordinate mapping regardless of CSS transforms
      const pt = svgRef.current.createSVGPoint();
      pt.x = mouseClientXRef.current;
      pt.y = 0;
      const ctm = svgRef.current.getScreenCTM();
      if (!ctm) return;
      const mx = pt.matrixTransform(ctm.inverse()).x;
      const data = hoverDataRef.current;
      const { allPoints, minT, maxT, chartW, seriesData, enabledKeys } = data;

      // Update crosshair line — follows mouse exactly
      if (hoverLineRef.current) {
        if (mx >= PAD.left && mx <= PAD.left + chartW) {
          hoverLineRef.current.setAttribute('x1', mx.toFixed(1));
          hoverLineRef.current.setAttribute('x2', mx.toFixed(1));
          hoverLineRef.current.setAttribute('visibility', 'visible');
        } else {
          hoverLineRef.current.setAttribute('visibility', 'hidden');
        }
      }

      if (!hoverGroupRef.current || allPoints.length === 0) return;
      const t = minT + (mx - PAD.left) / chartW * (maxT - minT);
      const closest = allPoints.reduce((best, p) =>
        Math.abs(p.time - t) < Math.abs(best.time - t) ? p : best, allPoints[0]);

      const tooltipW = 210;
      // Tooltip anchors to mouse X, not data point X — line and tooltip stay in sync
      const tooltipX = mx + tooltipW + 20 > dims.w ? mx - tooltipW - 8 : mx + 8;
      const tooltipY = PAD.top + 8;
      const visibleSeries = enabledKeys;
      const tooltipH = 30 + visibleSeries.length * 20 + 18;
      const ty = (v: number) => PAD.top + (1 - (v - yMin) / yRange) * chartH;

      const g = hoverGroupRef.current;
      g.setAttribute('visibility', 'visible');
      g.innerHTML = '';

      // Dots on each series
      visibleSeries.forEach(key => {
        const pts = seriesData[key as keyof typeof seriesData];
        const p = pts.reduce((best, pp) => Math.abs(pp.time - closest.time) < Math.abs(best.time - closest.time) ? pp : best, pts[0]);
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', (PAD.left + (p.time - minT) / (maxT - minT) * chartW).toFixed(1));
        dot.setAttribute('cy', ty(p.cumPL).toFixed(1));
        dot.setAttribute('r', '5');
        dot.setAttribute('fill', COLORS[key]);
        dot.setAttribute('stroke', '#1e2329');
        dot.setAttribute('stroke-width', '2');
        g.appendChild(dot);
      });

      // Tooltip bg
      const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect2.setAttribute('x', tooltipX.toString());
      rect2.setAttribute('y', tooltipY.toString());
      rect2.setAttribute('width', tooltipW.toString());
      rect2.setAttribute('height', tooltipH.toString());
      rect2.setAttribute('fill', '#1e2329');
      rect2.setAttribute('stroke', '#2b3139');
      rect2.setAttribute('stroke-width', '1');
      rect2.setAttribute('rx', '6');
      g.appendChild(rect2);

      // Title
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', (tooltipX + 10).toString());
      title.setAttribute('y', (tooltipY + 16).toString());
      title.setAttribute('fill', '#eaecef');
      title.setAttribute('font-size', '11');
      title.setAttribute('font-weight', '600');
      title.textContent = `${closest.trade.instrument.replace('_', '/')} · ${closest.trade.direction.toUpperCase()} · ${fmtDate(closest.time)}`;
      g.appendChild(title);

      // Series rows
      visibleSeries.forEach((key, i) => {
        const pts = seriesData[key as keyof typeof seriesData];
        const p = pts.reduce((best, pp) => Math.abs(pp.time - closest.time) < Math.abs(best.time - closest.time) ? pp : best, pts[0]);
        const v = p.cumPL;

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', (tooltipX + 10).toString());
        dot.setAttribute('cy', (tooltipY + 30 + i * 20).toString());
        dot.setAttribute('r', '4');
        dot.setAttribute('fill', COLORS[key]);
        g.appendChild(dot);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', (tooltipX + 20).toString());
        label.setAttribute('y', (tooltipY + 34 + i * 20).toString());
        label.setAttribute('fill', '#848e9c');
        label.setAttribute('font-size', '10');
        label.textContent = LABELS[key];
        g.appendChild(label);

        const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        val.setAttribute('x', (tooltipX + tooltipW - 10).toString());
        val.setAttribute('y', (tooltipY + 34 + i * 20).toString());
        val.setAttribute('text-anchor', 'end');
        val.setAttribute('fill', v >= 0 ? '#0ecb81' : '#f6465d');
        val.setAttribute('font-size', '10');
        val.setAttribute('font-weight', '600');
        val.textContent = fmtPL(v);
        g.appendChild(val);
      });

      // Trade P&L footer
      const footer = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      footer.setAttribute('x', (tooltipX + 10).toString());
      footer.setAttribute('y', (tooltipY + tooltipH - 6).toString());
      footer.setAttribute('fill', '#848e9c');
      footer.setAttribute('font-size', '9');
      const tradePL = parseFloat(closest.trade.realized_pl || '0');
      footer.textContent = `Trade P&L: ${fmtPL(tradePL)}`;
      g.appendChild(footer);
    });
  }, [dims.w, chartH, yMin, yRange]);

  const onMouseLeave = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    hoverLineRef.current?.setAttribute('visibility', 'hidden');
    hoverGroupRef.current?.setAttribute('visibility', 'hidden');
  }, []);

  if (closed.length === 0) {
    return (
      <>
        <Header />
        <main className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16 py-6 lg:py-8">
          <h2 className="text-lg lg:text-xl font-semibold mb-6">Performance</h2>
          <div className="bg-card border border-card-border rounded-lg p-12 text-center">
            <p className="text-muted">No closed trades yet — performance data will appear here once trades complete.</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16 py-6 lg:py-8 space-y-6">
        <h2 className="text-lg lg:text-xl font-semibold">Performance</h2>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 lg:gap-5">
          {(() => {
            const netPL = initialBalance > 0 && currentNav !== null
              ? currentNav - initialBalance
              : totalPL;
            const pct = initialBalance > 0 ? (netPL / initialBalance * 100) : null;
            return (
              <div className="bg-card border border-card-border rounded-lg p-4 lg:p-6">
                <p className="text-xs lg:text-sm text-muted uppercase tracking-wider mb-1">Net P&amp;L</p>
                <p className={`text-xl lg:text-2xl font-bold tabular-nums ${netPL >= 0 ? 'text-green' : 'text-red'}`}>{fmtPL(netPL)}</p>
                {pct !== null && (
                  <p className={`text-xs tabular-nums mt-0.5 ${netPL >= 0 ? 'text-green' : 'text-red'} opacity-70`}>
                    {pct >= 0 ? '+' : ''}{pct.toFixed(2)}% of £{initialBalance.toLocaleString()}
                  </p>
                )}
              </div>
            );
          })()}
          {[
            { label: 'Max Drawdown', value: `£${maxDD.toFixed(2)}`, color: maxDD > 0 ? 'text-red' : 'text-muted' },
            { label: 'Total Trades', value: closed.length.toString() },
            { label: 'Win Rate', value: `${winRate}%  ${wins.length}/${closed.length}`, color: winRate >= 50 ? 'text-green' : 'text-red' },
          ].map(s => (
            <div key={s.label} className="bg-card border border-card-border rounded-lg p-4 lg:p-6">
              <p className="text-xs lg:text-sm text-muted uppercase tracking-wider mb-1">{s.label}</p>
              <p className={`text-xl lg:text-2xl font-bold tabular-nums ${s.color || ''}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Chart card */}
        <div className="bg-card border border-card-border rounded-lg p-4 lg:p-6">
          {/* Toggles */}
          <div className="flex flex-wrap gap-2 mb-5">
            {(['ALL', ...PAIRS] as string[]).map(key => (
              <button key={key} onClick={() => select(key)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${
                  selectedKey === key ? 'border-transparent text-background' : 'border-card-border text-muted'
                }`}
                style={selectedKey === key ? { backgroundColor: COLORS[key] } : {}}
              >
                {LABELS[key]}
              </button>
            ))}
          </div>

          {/* SVG */}
          <div ref={containerRef} className="w-full">
            <svg ref={svgRef} width={dims.w} height={dims.h} viewBox={`0 0 ${dims.w} ${dims.h}`}
              className="w-full" style={{ display: 'block' }}
              onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>

              <defs>
                {paths.map(({ key, color }) => (
                  <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.2" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                  </linearGradient>
                ))}
              </defs>

              {/* Grid */}
              {yTicks.map(v => {
                const y = PAD.top + (1 - (v - yMin) / yRange) * chartH;
                return (
                  <line key={v} x1={PAD.left} y1={y.toFixed(1)} x2={PAD.left + chartW} y2={y.toFixed(1)}
                    stroke={v === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'}
                    strokeWidth={v === 0 ? 1.5 : 1} strokeDasharray={v === 0 ? undefined : '3,4'} />
                );
              })}

              {/* Y labels */}
              {yTicks.map(v => {
                const y = PAD.top + (1 - (v - yMin) / yRange) * chartH;
                return (
                  <text key={v} x={PAD.left - 8} y={y.toFixed(1)}
                    textAnchor="end" dominantBaseline="middle" fill="rgba(132,142,156,0.8)" fontSize={10}>
                    {v >= 0 ? `+£${v}` : `-£${Math.abs(v)}`}
                  </text>
                );
              })}

              {/* X labels */}
              {xTicks.map((t, i) => {
                const x = maxT > minT ? PAD.left + (t - minT) / (maxT - minT) * chartW : PAD.left;
                return (
                  <text key={i} x={x.toFixed(1)} y={PAD.top + chartH + 6}
                    textAnchor="middle" dominantBaseline="hanging" fill="rgba(132,142,156,0.6)" fontSize={10}>
                    {fmtDate(t)}
                  </text>
                );
              })}

              {/* Lines + fills + dots */}
              {paths.map(({ key, d, fillD, color, endX, endY, endPL, dots }) => (
                <g key={key}>
                  <path d={fillD} fill={`url(#grad-${key})`} />
                  <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                  {/* Win/loss dots */}
                  {dots.map((dot, i) => (
                    <circle key={i} cx={dot.x.toFixed(1)} cy={dot.y.toFixed(1)} r={3.5}
                      fill={dot.win ? '#0ecb81' : '#f6465d'}
                      stroke="#1e2329" strokeWidth={1.5} />
                  ))}
                  {/* End label */}
                  <text x={endX + 6} y={endY.toFixed(1)} dominantBaseline="middle"
                    fill={color} fontSize={10} fontWeight="600">
                    {fmtPL(endPL)}
                  </text>
                </g>
              ))}

              {/* Trade bars */}
              {barInfo.map(({ t, bx, bw, bh, by, color }) => (
                <rect key={t.id} x={(bx - bw / 2).toFixed(1)} y={by.toFixed(1)} width={bw} height={bh.toFixed(1)}
                  fill={color} opacity={0.75} rx={1} />
              ))}

              {/* Bar zero line */}
              {(() => {
                const barY0 = PAD.top + chartH + 12;
                const barMid = barY0 + (PAD.bars - 8) / 2;
                return <line x1={PAD.left} y1={barMid} x2={PAD.left + chartW} y2={barMid}
                  stroke="rgba(255,255,255,0.08)" strokeWidth={1} />;
              })()}

              {/* Crosshair — updated via ref */}
              <line ref={hoverLineRef} x1="0" y1={PAD.top} x2="0" y2={PAD.top + chartH + PAD.bars}
                stroke="rgba(255,255,255,0.2)" strokeWidth={1} strokeDasharray="3,3" visibility="hidden" />

              {/* Hover group — updated via DOM in rAF */}
              <g ref={hoverGroupRef} visibility="hidden" />
            </svg>
          </div>

          <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted">
            <span>— Equity curve</span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-green inline-block" /> Win
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red inline-block" /> Loss
            </span>
            <span>Bars = individual trades (green profit / red loss)</span>
          </div>
        </div>
      </main>
    </>
  );
}
