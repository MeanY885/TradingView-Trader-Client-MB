'use client';

import { useState, useEffect } from 'react';
import type { PairAnalysis } from '../app/api/profit-analysis/route';

interface Settings {
  initial_balance: string;
  risk_pct_EUR_USD: string;
  risk_pct_XAU_USD: string;
  risk_pct_NZD_JPY: string;
  profit_target_EUR_USD: string;
  profit_target_XAU_USD: string;
  profit_target_NZD_JPY: string;
  loss_target_EUR_USD: string;
  loss_target_XAU_USD: string;
  loss_target_NZD_JPY: string;
  enabled_EUR_USD: string;
  enabled_XAU_USD: string;
  enabled_NZD_JPY: string;
  max_slippage_pips_EUR_USD: string;
  max_slippage_pips_XAU_USD: string;
  max_slippage_pips_NZD_JPY: string;
  leverage: string;
  max_slippage_pips: string;
  // Broker selection
  broker: string;
  // Oanda credentials
  practice_account_id: string;
  live_account_id: string;
  hasPracticeKey: boolean;
  hasLiveKey: boolean;
  // IB Client Portal Gateway
  ib_gateway_url?: string;
  ib_account_id?: string;
  account_currency?: string;
  webhook_domain?: string;
  [key: string]: string | boolean | undefined;
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// Currency rates: each value = 1 unit of that currency in account currency
interface FxRates { base: string; USD: number; EUR: number; JPY: number; NZD: number; GBP: number; XAU: number; }
const FALLBACK_RATES: Record<string, FxRates> = {
  GBP: { base: 'GBP', USD: 0.79, EUR: 0.857, JPY: 0.0051, NZD: 0.457, GBP: 1,    XAU: 2400 },
  USD: { base: 'USD', USD: 1,    EUR: 0.92,  JPY: 0.0067, NZD: 0.614, GBP: 1.27,  XAU: 3000 },
  EUR: { base: 'EUR', USD: 1.09, EUR: 1,     JPY: 0.0062, NZD: 0.565, GBP: 1.17,  XAU: 2750 },
  JPY: { base: 'JPY', USD: 0.0067, EUR: 0.0062, JPY: 1,   NZD: 0.0041, GBP: 0.0084, XAU: 20.1 },
};

const CCY_SYMBOLS: Record<string, string> = {
  GBP: '£', USD: '$', EUR: '€', JPY: '¥', AUD: 'A$', CAD: 'C$', CHF: 'Fr',
};

// pip monetary impact per 1 account-currency unit of allocated balance:
//   pipSize × rates[quoteCcy] / rates[baseCcy]
const PAIRS = [
  { key: 'EUR_USD', label: 'EUR/USD', pipSize: 0.0001,
    pipImpact: (r: FxRates) => 0.0001 * r.USD / r.EUR },
  { key: 'XAU_USD', label: 'XAU/USD', pipSize: 1.0,
    pipImpact: (r: FxRates) => r.USD / r.XAU },
  { key: 'NZD_JPY', label: 'NZD/JPY', pipSize: 0.01,
    pipImpact: (r: FxRates) => 0.01 * r.JPY / r.NZD },
];

interface ReauthEvent {
  timestamp: string;
  success: boolean;
  method: string;
  detail?: string;
}

function ReauthLog() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ReauthEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLog = () => {
    setLoading(true);
    fetch('/api/ib-reauth-log')
      .then((r) => r.json())
      .then((data) => setEvents(data.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) fetchLog();
  }, [open]);

  return (
    <details
      className="border-t border-card-border pt-3"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 cursor-pointer text-xs text-muted hover:text-foreground transition-colors select-none">
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 12 12" fill="currentColor">
          <path d="M4 2l4 4-4 4z" />
        </svg>
        Re-authentication Log
        {events.length > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-card-border text-[10px] tabular-nums">{events.length}</span>
        )}
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); fetchLog(); }}
            className="ml-auto text-[10px] text-muted hover:text-foreground px-2 py-0.5 rounded border border-card-border"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        )}
      </summary>
      <div className="mt-2 max-h-52 overflow-y-auto">
        {events.length === 0 ? (
          <p className="text-xs text-muted py-2">No re-authentication events yet. Events will appear here when the keepalive detects and recovers from session drops.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted border-b border-card-border">
                <th className="text-left py-1 pr-3 font-medium">Time</th>
                <th className="text-left py-1 pr-3 font-medium">Status</th>
                <th className="text-left py-1 pr-3 font-medium">Method</th>
                <th className="text-left py-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt, i) => (
                <tr key={i} className="border-b border-card-border/50">
                  <td className="py-1.5 pr-3 text-muted tabular-nums whitespace-nowrap">
                    {new Date(evt.timestamp).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className={`inline-flex items-center gap-1 ${evt.success ? 'text-green' : 'text-red'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${evt.success ? 'bg-green' : 'bg-red'}`} />
                      {evt.success ? 'OK' : 'FAIL'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-foreground">{evt.method}</td>
                  <td className="py-1.5 text-muted">{evt.detail || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

export default function SettingsForm() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [posMsg, setPosMsg] = useState('');
  const [profitMsg, setProfitMsg] = useState('');
  const [apiMsg, setApiMsg] = useState('');
  const [practiceKey, setPracticeKey] = useState('');
  const [liveKey, setLiveKey] = useState('');
  const [showPracticeKey, setShowPracticeKey] = useState(false);
  const [showLiveKey, setShowLiveKey] = useState(false);
  // IB gateway status
  const [ibGatewayStatus, setIbGatewayStatus] = useState<{ authenticated: boolean; connected: boolean; competing?: boolean; message?: string } | null>(null);
  const [ibStatusChecking, setIbStatusChecking] = useState(false);
  const [ibReauthInProgress, setIbReauthInProgress] = useState(false);
  const [ibReauthMsg, setIbReauthMsg] = useState('');
  const [brokerMsg, setBrokerMsg] = useState('');
  const [balance, setBalance] = useState(0);
  const [balanceInputs, setBalanceInputs] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<Record<string, PairAnalysis> | null>(null);
  const [fxRates, setFxRates] = useState<FxRates | null>(null);
  const [sslDomain, setSslDomain] = useState('');
  const [sslMsg, setSslMsg] = useState('');
  const [sslChecking, setSslChecking] = useState(false);
  const [ipEnabled, setIpEnabled] = useState(false);
  const [ipList, setIpList] = useState<string[]>([]);
  const [ipInput, setIpInput] = useState('');
  const [ipMsg, setIpMsg] = useState('');
  const [dnsResolved, setDnsResolved] = useState<Record<string, string[]>>({});
  const [sslStatus, setSslStatus] = useState<{
    configured: boolean;
    domain?: string;
    hasCert?: boolean;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    daysUntilExpiry?: number;
    error?: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      setSettings(d);
      if (d.webhook_domain) setSslDomain(d.webhook_domain);
      if (d.ip_whitelist_enabled) setIpEnabled(d.ip_whitelist_enabled === 'true');
      if (d.ip_whitelist) { try { setIpList(JSON.parse(d.ip_whitelist)); } catch {} }
    }).catch(() => setPosMsg('Failed to load settings'));
    fetch('/api/ssl').then((r) => r.json()).then(setSslStatus).catch(() => {});
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      const ccy = d.account_currency || 'GBP';
      fetch(`/api/fx-rates?ccy=${ccy}`).then((r) => r.json()).then((rates) => { if (rates.base) setFxRates(rates); }).catch(() => {});
    }).catch(() => {});
    fetch('/api/account').then((r) => r.json()).then((d) => {
      if (d.balance) {
        const bal = parseFloat(d.balance);
        setBalance(bal);
        fetch(`/api/profit-analysis?balance=${bal}`).then((r) => r.json()).then(setAnalysis).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // Resolve DNS hostnames in the allowlist
  useEffect(() => {
    const hostnames = ipList.filter((e) => /[a-zA-Z]/.test(e) && e.includes('.'));
    if (hostnames.length === 0) { setDnsResolved({}); return; }
    fetch('/api/dns-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostnames }),
    }).then((r) => r.json()).then((d) => setDnsResolved(d.resolved || {})).catch(() => {});
  }, [ipList]);

  // Poll IB gateway status every 30s when IB is selected
  useEffect(() => {
    if ((settings?.broker || 'oanda') !== 'interactive_brokers') return;
    const checkStatus = () => {
      fetch('/api/ib-status').then((r) => r.json()).then(setIbGatewayStatus).catch(() => {});
    };
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, [settings?.broker]);

  const save = async (data: Record<string, string>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (res.ok) {
        // Only merge the keys we submitted — don't let the full DB response
        // overwrite unsaved changes in other sections of the form.
        setSettings((s) => s ? { ...s, ...data } : s);
        return { ok: true };
      }
      return { ok: false, error: json.error || 'Failed to save' };
    } catch {
      return { ok: false, error: 'Failed to save' };
    } finally {
      setSaving(false);
    }
  };

  const savePositionSizing = async () => {
    if (!settings) return;
    const result = await save({
      leverage: settings.leverage,
      initial_balance: settings.initial_balance || '',
      account_currency: settings.account_currency || 'GBP',
    });
    setPosMsg(result.ok ? 'Saved' : (result.error || 'Error'));
    setTimeout(() => setPosMsg(''), 2000);
  };

  const saveRiskAndProfit = async () => {
    if (!settings) return;
    const data: Record<string, string> = {};
    for (const pair of PAIRS) {
      data[`risk_pct_${pair.key}`] = settings[`risk_pct_${pair.key}`] as string || '0';
      data[`profit_target_${pair.key}`] = settings[`profit_target_${pair.key}`] as string || '0';
      data[`loss_target_${pair.key}`] = settings[`loss_target_${pair.key}`] as string || '0';
      data[`enabled_${pair.key}`] = settings[`enabled_${pair.key}`] as string || 'true';
      data[`max_slippage_pips_${pair.key}`] = settings[`max_slippage_pips_${pair.key}`] as string || '0';
    }
    const result = await save(data);
    setProfitMsg(result.ok ? 'Saved' : (result.error || 'Error'));
    setTimeout(() => setProfitMsg(''), 2000);
  };

  const saveApiConfig = async () => {
    if (!settings) return;
    setSaving(true);
    setApiMsg('');
    const broker = settings.broker || 'oanda';
    const data: Record<string, string> = {};

    if (broker === 'oanda') {
      data.practice_account_id = settings.practice_account_id || '';
      data.live_account_id = settings.live_account_id || '';
      if (practiceKey.trim()) data.practice_api_key = practiceKey.trim();
      if (liveKey.trim()) data.live_api_key = liveKey.trim();
    } else if (broker === 'interactive_brokers') {
      data.ib_gateway_url = settings.ib_gateway_url || 'http://localhost:5000';
      data.ib_account_id = settings.ib_account_id || '';
    }

    const result = await save(data);
    if (result.ok) {
      setPracticeKey(''); setLiveKey('');
    }
    setApiMsg(result.ok ? 'Saved' : (result.error || 'Error'));
    setTimeout(() => setApiMsg(''), 2000);
  };

  const saveBrokerSelection = async () => {
    if (!settings) return;
    const result = await save({ broker: settings.broker || 'oanda' });
    setBrokerMsg(result.ok ? 'Saved' : (result.error || 'Error'));
    setTimeout(() => setBrokerMsg(''), 2000);
  };

  const checkSslStatus = async () => {
    setSslChecking(true);
    try {
      const res = await fetch('/api/ssl');
      const data = await res.json();
      setSslStatus(data);
    } catch {
      setSslStatus({ configured: false, error: 'Failed to check status' });
    } finally {
      setSslChecking(false);
    }
  };

  const applySsl = async () => {
    const domain = sslDomain.trim().toLowerCase();
    if (!domain) { setSslMsg('Enter a domain first'); setTimeout(() => setSslMsg(''), 3000); return; }
    setSslChecking(true);
    setSslMsg('');
    try {
      const res = await fetch('/api/ssl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSslMsg(data.error || 'Error');
        setTimeout(() => setSslMsg(''), 4000);
        return;
      }
      setSslMsg('Applied — certificate will be issued shortly');
      // Poll cert status after a brief delay for Caddy to attempt ACME
      setTimeout(async () => {
        const s = await fetch('/api/ssl').then((r) => r.json()).catch(() => null);
        if (s) setSslStatus(s);
        setSslMsg('');
        setSslChecking(false);
      }, 5000);
    } catch {
      setSslMsg('Request failed');
      setTimeout(() => setSslMsg(''), 3000);
      setSslChecking(false);
    }
  };

  const TV_IPS = ['52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7'];
  const LOCAL_IPS = ['127.0.0.1', '10.0.0.0/8', '192.168.0.0/16'];

  const addIp = () => {
    const ip = ipInput.trim();
    if (!ip || ipList.includes(ip)) { setIpInput(''); return; }
    setIpList((prev) => [...prev, ip]);
    setIpInput('');
  };

  const removeIp = (ip: string) => setIpList((prev) => prev.filter((x) => x !== ip));

  const addTvIps = () => {
    setIpList((prev) => [...prev, ...TV_IPS.filter((ip) => !prev.includes(ip))]);
  };

  const removeTvIps = () => {
    setIpList((prev) => prev.filter((ip) => !TV_IPS.includes(ip)));
  };

  const hasTvIps = TV_IPS.every((ip) => ipList.includes(ip));
  const hasLocalIps = LOCAL_IPS.every((ip) => ipList.includes(ip));

  const addLocalIps = () => {
    setIpList((prev) => [...prev, ...LOCAL_IPS.filter((ip) => !prev.includes(ip))]);
  };

  const removeLocalIps = () => {
    setIpList((prev) => prev.filter((ip) => !LOCAL_IPS.includes(ip)));
  };

  const saveIpAllowlist = async () => {
    const result = await save({
      ip_whitelist_enabled: String(ipEnabled),
      ip_whitelist: JSON.stringify(ipList),
    });
    setIpMsg(result.ok ? 'Saved' : (result.error || 'Error'));
    setTimeout(() => setIpMsg(''), 2000);
  };

  if (!settings) {
    return <div className="animate-pulse bg-card border border-card-border rounded-lg p-6 h-64" />;
  }

  const leverage = parseInt(settings.leverage || '1', 10);
  const accountCurrency = settings.account_currency || 'GBP';
  const currencySymbol = CCY_SYMBOLS[accountCurrency] ?? accountCurrency;
  const rates = fxRates ?? FALLBACK_RATES[accountCurrency] ?? FALLBACK_RATES['GBP'];

  const riskTotal = PAIRS.reduce((sum, p) => sum + parseFloat(settings[`risk_pct_${p.key}`] as string || '0'), 0);
  const riskTotalOver = riskTotal > 100;

  return (
    <div className="space-y-6">
      {/* Broker Selection */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">Broker</h2>
        <p className="text-xs text-muted mb-5">Select your broker. Changing broker will update the API credentials section below.</p>

        <div className="flex items-center gap-3">
          <select
            value={settings.broker || 'oanda'}
            onChange={(e) => setSettings({ ...settings, broker: e.target.value })}
            className="bg-background border border-card-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
          >
            <option value="oanda">OANDA</option>
            <option value="interactive_brokers">Interactive Brokers</option>
          </select>
          <button
            onClick={saveBrokerSelection}
            disabled={saving}
            className="px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {brokerMsg && (
            <span className={`text-sm ${brokerMsg === 'Saved' ? 'text-green' : 'text-red'}`}>{brokerMsg}</span>
          )}
        </div>
      </div>

      {/* API Credentials */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">API Credentials</h2>
        <p className="text-xs text-muted mb-5">
          {(settings.broker || 'oanda') === 'oanda'
            ? 'Enter your OANDA API keys and account IDs.'
            : 'Configure the IB Client Portal Gateway URL and account ID. The gateway must be running and you must log in via browser.'}
        </p>

        {(settings.broker || 'oanda') === 'oanda' ? (
          <div className="space-y-4 max-w-md">
            <div>
              <label className="block text-xs text-muted mb-1">Practice Account ID</label>
              <input
                type="text"
                value={settings.practice_account_id || ''}
                onChange={(e) => setSettings({ ...settings, practice_account_id: e.target.value })}
                className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                placeholder="e.g. 101-004-12345678-001"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Practice API Key {settings.hasPracticeKey && <span className="text-green ml-1">✓ Set</span>}</label>
              <div className="flex items-center gap-2">
                <input
                  type={showPracticeKey ? 'text' : 'password'}
                  value={practiceKey}
                  onChange={(e) => setPracticeKey(e.target.value)}
                  className="flex-1 bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                  placeholder={settings.hasPracticeKey ? '••••••••' : 'Paste API key'}
                />
                <button type="button" onClick={() => setShowPracticeKey(!showPracticeKey)} className="text-muted hover:text-foreground transition-colors p-1">
                  <EyeIcon open={showPracticeKey} />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Live Account ID</label>
              <input
                type="text"
                value={settings.live_account_id || ''}
                onChange={(e) => setSettings({ ...settings, live_account_id: e.target.value })}
                className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                placeholder="e.g. 001-004-12345678-001"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Live API Key {settings.hasLiveKey && <span className="text-green ml-1">✓ Set</span>}</label>
              <div className="flex items-center gap-2">
                <input
                  type={showLiveKey ? 'text' : 'password'}
                  value={liveKey}
                  onChange={(e) => setLiveKey(e.target.value)}
                  className="flex-1 bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                  placeholder={settings.hasLiveKey ? '••••••••' : 'Paste API key'}
                />
                <button type="button" onClick={() => setShowLiveKey(!showLiveKey)} className="text-muted hover:text-foreground transition-colors p-1">
                  <EyeIcon open={showLiveKey} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Session Status Banner */}
            <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
              ibGatewayStatus?.authenticated
                ? 'bg-green/10 border-green/30'
                : ibGatewayStatus === null
                  ? 'bg-card border-card-border'
                  : 'bg-red/10 border-red/30'
            }`}>
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                ibGatewayStatus?.authenticated ? 'bg-green animate-pulse' : ibGatewayStatus === null ? 'bg-muted' : 'bg-red'
              }`} />
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium ${ibGatewayStatus?.authenticated ? 'text-green' : ibGatewayStatus === null ? 'text-muted' : 'text-red'}`}>
                  {ibGatewayStatus === null
                    ? 'Checking gateway...'
                    : ibGatewayStatus.authenticated
                      ? 'Gateway Authenticated'
                      : 'Gateway Not Authenticated'}
                </span>
                {ibGatewayStatus && !ibGatewayStatus.authenticated && (
                  <p className="text-xs text-muted mt-0.5">
                    {ibGatewayStatus.message || 'Login required. Click "Log In to Gateway" below.'}
                  </p>
                )}
                {ibGatewayStatus?.competing && (
                  <p className="text-xs text-yellow mt-0.5">Another session is competing for this username.</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setIbStatusChecking(true);
                  fetch('/api/ib-status').then((r) => r.json()).then(setIbGatewayStatus).catch(() =>
                    setIbGatewayStatus({ authenticated: false, connected: false, message: 'Cannot reach app server' })
                  ).finally(() => setIbStatusChecking(false));
                }}
                disabled={ibStatusChecking}
                className="px-3 py-1 bg-background border border-card-border rounded text-xs hover:border-accent transition-colors disabled:opacity-50 shrink-0"
              >
                {ibStatusChecking ? '...' : 'Refresh'}
              </button>
            </div>

            {/* Account ID */}
            <div className="max-w-md">
              <label className="block text-xs text-muted mb-1">Account ID</label>
              <input
                type="text"
                value={settings.ib_account_id || ''}
                onChange={(e) => setSettings({ ...settings, ib_account_id: e.target.value })}
                className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                placeholder="e.g. DUP652326"
              />
              <p className="text-xs text-muted mt-1">Your IB account ID. For paper trading, use your paper account ID.</p>
            </div>

            {/* Gateway URL (collapsed by default) */}
            <details className="max-w-md">
              <summary className="text-xs text-muted cursor-pointer hover:text-foreground transition-colors">Advanced: Gateway URL</summary>
              <div className="mt-2">
                <input
                  type="text"
                  value={settings.ib_gateway_url || 'http://localhost:5000'}
                  onChange={(e) => setSettings({ ...settings, ib_gateway_url: e.target.value })}
                  className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                  placeholder="http://localhost:5000"
                />
                <p className="text-xs text-muted mt-1">Default: http://ib-gateway:5000 in Docker. Only change if you run the gateway elsewhere.</p>
              </div>
            </details>

            {/* Gateway Login */}
            <div className="border-t border-card-border pt-4">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-xs text-muted uppercase tracking-wider">Gateway Login</label>
                <div className="flex gap-2">
                  {ibGatewayStatus?.authenticated ? (
                    <button
                      type="button"
                      disabled={ibReauthInProgress}
                      onClick={async () => {
                        // Try server-side re-auth first (works for expired sessions)
                        setIbReauthInProgress(true);
                        setIbReauthMsg('Re-authenticating...');
                        try {
                          const res = await fetch('/api/ib-reauth', { method: 'POST' });
                          const data = await res.json();
                          if (data.success) {
                            setIbReauthMsg('Session renewed');
                            setIbGatewayStatus(data.status);
                          } else {
                            setIbReauthMsg('Session expired — opening login...');
                            // Fall back to login page via Caddy proxy (no self-signed cert issues)
                            const loginPopup = window.open(
                              `${window.location.origin}/sso/Login?forwardTo=22&RL=1&ip2loc=US`,
                              'ib_login',
                              'width=500,height=700,scrollbars=yes'
                            );
                            // Poll for successful auth while popup is open
                            const pollId = setInterval(async () => {
                              try {
                                const statusRes = await fetch('/api/ib-status');
                                const statusData = await statusRes.json();
                                if (statusData.authenticated) {
                                  setIbGatewayStatus(statusData);
                                  setIbReauthMsg('Authenticated');
                                  clearInterval(pollId);
                                  loginPopup?.close();
                                }
                              } catch { /* ignore */ }
                            }, 3000);
                            // Stop polling after 5 minutes
                            setTimeout(() => { clearInterval(pollId); setIbReauthMsg(''); }, 300000);
                          }
                        } catch {
                          setIbReauthMsg('Re-auth failed');
                        } finally {
                          setIbReauthInProgress(false);
                          setTimeout(() => setIbReauthMsg(''), 5000);
                        }
                      }}
                      className="px-4 py-1.5 text-xs font-semibold rounded bg-background border border-card-border text-muted hover:border-accent transition-colors disabled:opacity-50"
                    >
                      {ibReauthInProgress ? 'Re-authenticating...' : 'Re-authenticate'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        // Open login page via Caddy proxy — avoids self-signed cert issues
                        const loginPopup = window.open(
                          `${window.location.origin}/sso/Login?forwardTo=22&RL=1&ip2loc=US`,
                          'ib_login',
                          'width=500,height=700,scrollbars=yes'
                        );
                        setIbReauthMsg('Waiting for login...');
                        // Poll for successful auth while popup is open
                        const pollId = setInterval(async () => {
                          try {
                            const statusRes = await fetch('/api/ib-status');
                            const statusData = await statusRes.json();
                            if (statusData.authenticated) {
                              setIbGatewayStatus(statusData);
                              setIbReauthMsg('Authenticated');
                              clearInterval(pollId);
                              loginPopup?.close();
                              setTimeout(() => setIbReauthMsg(''), 3000);
                            }
                          } catch { /* ignore */ }
                        }, 3000);
                        // Stop polling after 5 minutes
                        setTimeout(() => { clearInterval(pollId); setIbReauthMsg(''); }, 300000);
                      }}
                      className="px-4 py-1.5 text-xs font-semibold rounded bg-accent text-background hover:bg-accent/90 transition-colors"
                    >
                      Log In to Gateway
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted">
                {ibReauthMsg ? (
                  <span className={ibReauthMsg === 'Authenticated' || ibReauthMsg === 'Session renewed' ? 'text-green' : 'text-accent'}>
                    {ibReauthMsg}
                  </span>
                ) : ibGatewayStatus?.authenticated
                  ? 'Session is active. It will be kept alive automatically. IB requires manual re-login once per week (Sunday). Daily maintenance around 01:00 ET may briefly disconnect — click Re-authenticate to restore.'
                  : 'Opens the IB gateway login page. Log in with your IB credentials and 2FA — this page will update automatically when login succeeds.'}
              </p>
            </div>

            {/* Re-authentication Log */}
            <ReauthLog />
          </div>
        )}

        <button
          onClick={saveApiConfig}
          disabled={saving}
          className="mt-6 px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Credentials'}
        </button>
        {apiMsg && (
          <span className={`ml-3 text-sm ${apiMsg === 'Saved' ? 'text-green' : 'text-red'}`}>{apiMsg}</span>
        )}
      </div>

      {/* Position Sizing */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-6">Position Sizing</h2>
        <div className="space-y-5">
          <div>
            <label className="block text-sm text-muted mb-1.5">Account Currency</label>
            <div className="flex items-center gap-3">
              <select
                value={accountCurrency}
                onChange={(e) => setSettings({ ...settings, account_currency: e.target.value })}
                className="bg-background border border-card-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
              >
                {['GBP', 'USD', 'EUR', 'JPY', 'AUD', 'CAD', 'CHF'].map((c) => (
                  <option key={c} value={c}>{c} ({CCY_SYMBOLS[c] ?? c})</option>
                ))}
              </select>
              <span className="text-xs text-muted">Auto-detected from your broker. Must match your account currency.</span>
            </div>
          </div>
          <div>
            <label className="block text-sm text-muted mb-1.5">Initial Investment</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">{currencySymbol}</span>
              <input
                type="number"
                min="0"
                step="1"
                value={settings.initial_balance || ''}
                onChange={(e) => setSettings({ ...settings, initial_balance: e.target.value })}
                placeholder="e.g. 3000"
                className="w-40 bg-background border border-card-border rounded px-3 py-2 text-sm tabular-nums focus:outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">Used to calculate % return on the Performance page</span>
            </div>
          </div>
          <div>
            <label className="block text-sm text-muted mb-1.5">
              Leverage: {leverage === 1 ? 'No leverage' : `${leverage}:1`}
            </label>
            <input
              type="range"
              min="1"
              max="30"
              value={leverage}
              onChange={(e) => setSettings({ ...settings, leverage: e.target.value })}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-muted mt-1">
              <span>1:1</span>
              <span>15:1</span>
              <span>30:1</span>
            </div>
          </div>
        </div>
        <button
          onClick={savePositionSizing}
          disabled={saving}
          className="mt-6 px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {posMsg && (
          <span className={`ml-3 text-sm ${posMsg === 'Saved' ? 'text-green' : 'text-red'}`}>
            {posMsg}
          </span>
        )}
      </div>

      {/* Per-Pair Risk & Profit Exit */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">Per-Pair Risk, Profit &amp; Loss Exit</h2>
        <p className="text-xs text-muted mb-5">
          Risk % is the maximum each pair can deploy. On entry, the system uses min(configured %, remaining free balance) — so a pair never exceeds its cap but will downscale if other trades are already using capital. Profit exit closes when unrealized profit reaches the {currencySymbol} target; Loss exit closes when unrealized loss reaches the {currencySymbol} target (0 = disabled for both).
        </p>

        <div className="mb-3">
          <div className="grid gap-4 text-xs text-muted uppercase tracking-wider mb-2" style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr 1fr' }}>
            <span>Active</span>
            <span>Pair</span>
            <span>Risk %</span>
            <span>≈ Balance</span>
            <span>Loss Exit {currencySymbol}</span>
            <span>Profit Exit {currencySymbol}</span>
            <span>Max Slip</span>
          </div>
          <div className="space-y-3">
            {PAIRS.map((pair) => {
              const riskPct = parseFloat(settings[`risk_pct_${pair.key}`] as string || '0');
              const balanceAlloc = balance > 0 ? (balance * riskPct / 100).toFixed(0) : '—';
              const isEnabled = (settings[`enabled_${pair.key}`] as string) !== 'false';
              return (
                <div key={pair.key} className={`grid gap-4 items-center transition-opacity ${isEnabled ? '' : 'opacity-50'}`} style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr 1fr' }}>
                  {/* Toggle */}
                  <button
                    type="button"
                    onClick={() => setSettings({ ...settings, [`enabled_${pair.key}`]: isEnabled ? 'false' : 'true' })}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${isEnabled ? 'bg-accent' : 'bg-card-border'}`}
                    title={isEnabled ? 'Disable pair' : 'Enable pair'}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                  <span className="text-sm font-medium">{pair.label}</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      disabled={!isEnabled}
                      value={riskPct ? parseFloat(riskPct.toFixed(1)) : ''}
                      onChange={(e) => setSettings({ ...settings, [`risk_pct_${pair.key}`]: e.target.value })}
                      className="w-20 bg-background border border-card-border rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
                    />
                    <span className="text-xs text-muted">%</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted">{currencySymbol}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={balanceInputs[pair.key] !== undefined ? balanceInputs[pair.key] : (balance > 0 ? balanceAlloc : '')}
                      disabled={balance <= 0 || !isEnabled}
                      onFocus={() => setBalanceInputs((b) => ({ ...b, [pair.key]: balance > 0 ? balanceAlloc : '' }))}
                      onChange={(e) => setBalanceInputs((b) => ({ ...b, [pair.key]: e.target.value }))}
                      onBlur={(e) => {
                        const typed = parseFloat(e.target.value);
                        if (!isNaN(typed) && balance > 0) {
                          const pct = Math.min(100, typed / balance * 100);
                          setSettings((s) => s ? { ...s, [`risk_pct_${pair.key}`]: pct.toFixed(4) } : s);
                        }
                        setBalanceInputs((b) => { const n = { ...b }; delete n[pair.key]; return n; });
                      }}
                      placeholder="—"
                      className="w-24 bg-background border border-card-border rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted">{currencySymbol}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      disabled={!isEnabled}
                      value={settings[`loss_target_${pair.key}`] as string || ''}
                      onChange={(e) => setSettings({ ...settings, [`loss_target_${pair.key}`]: e.target.value })}
                      placeholder="0"
                      className="w-24 bg-background border border-card-border rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted">{currencySymbol}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      disabled={!isEnabled}
                      value={settings[`profit_target_${pair.key}`] as string || ''}
                      onChange={(e) => setSettings({ ...settings, [`profit_target_${pair.key}`]: e.target.value })}
                      placeholder="0"
                      className="w-24 bg-background border border-card-border rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="0.5"
                        disabled={!isEnabled}
                        value={settings[`max_slippage_pips_${pair.key}`] as string || ''}
                        onChange={(e) => setSettings({ ...settings, [`max_slippage_pips_${pair.key}`]: e.target.value })}
                        placeholder="0"
                        className="w-20 bg-background border border-card-border rounded px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
                      />
                      <span className="text-xs text-muted">pip</span>
                    </div>
                    {(() => {
                      const pips = parseFloat(settings[`max_slippage_pips_${pair.key}`] as string || '0');
                      if (pips <= 0) return null;
                      const allocatedGbp = balance > 0
                        ? balance * parseFloat(settings[`risk_pct_${pair.key}`] as string || '0') / 100
                        : 0;
                      if (allocatedGbp <= 0) return null;
                      const slipCost = pips * pair.pipImpact(rates) * allocatedGbp;
                      const approx = !fxRates;
                      return (
                        <span className="text-xs text-muted/60 tabular-nums pl-0.5">
                          {approx ? '~' : '≈'} {currencySymbol}{slipCost.toFixed(2)} slip cost
                        </span>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-6 mt-3 mb-4">
          <div className={`text-xs ${riskTotalOver ? 'text-accent' : 'text-muted'}`}>
            Total configured: {riskTotal.toFixed(1)}%{riskTotalOver ? ' — overlapping signals will downscale to fit free balance' : ''}
          </div>
          {balance > 0 && (
            <div className="text-xs text-muted">
              Available balance:{' '}
              <span className={`font-medium tabular-nums ${Math.max(0, balance - PAIRS.reduce((s, p) => s + parseFloat(settings[`risk_pct_${p.key}`] as string || '0') / 100 * balance, 0)) < balance * 0.05 ? 'text-red' : 'text-foreground'}`}>
                {currencySymbol}{Math.max(0, balance - PAIRS.reduce((s, p) => s + parseFloat(settings[`risk_pct_${p.key}`] as string || '0') / 100 * balance, 0)).toFixed(0)}
              </span>
              {' '}/ {currencySymbol}{balance.toFixed(0)}
            </div>
          )}
        </div>

        <button
          onClick={saveRiskAndProfit}
          disabled={saving}
          className="px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {profitMsg && (
          <span className={`ml-3 text-sm ${profitMsg === 'Saved' ? 'text-green' : 'text-red'}`}>
            {profitMsg}
          </span>
        )}

        {/* Profit Exit Optimiser */}
        {analysis && Object.keys(analysis).length > 0 && (
          <div className="mt-6 pt-5 border-t border-card-border">
            <div className="flex items-baseline gap-2 mb-1">
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider">Profit Exit Optimiser</h3>
            </div>
            <p className="text-xs text-muted mb-4">
              Safe exit = highest {currencySymbol} level that 90%+ of trades passed through before TP or SL. Based on peak unrealised P&L per trade.
            </p>

            {/* Column headers */}
            <div className="grid text-xs text-muted uppercase tracking-wider mb-2 px-1" style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr' }}>
              <span className="w-16" />
              <span>Trades</span>
              <span>Current exit</span>
              <span>Safe exit (90%)</span>
              <span>Suggestion</span>
            </div>

            <div className="space-y-2">
              {PAIRS.map((pair) => {
                const a = analysis[pair.key];
                const count = a?.tradeCount ?? 0;

                if (!a || count < 5) {
                  return (
                    <div key={pair.key} className="grid items-center gap-4 px-1 py-2 rounded text-sm" style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr' }}>
                      <span className="font-medium w-16 text-foreground/50">{pair.label}</span>
                      <span className="text-xs text-muted tabular-nums">{count} / 5</span>
                      <span className="text-xs text-muted">—</span>
                      <span className="text-xs text-muted">—</span>
                      <span className="text-xs text-muted">Need {5 - count} more trade{5 - count !== 1 ? 's' : ''}</span>
                    </div>
                  );
                }

                const { currentExit, safeExit, winRateAtSafe, winRateAtCurrent, hitsAtCurrent, direction } = a;

                const directionConfig = {
                  increase: { label: '↑ Increase', color: 'text-green', bg: 'bg-green/10' },
                  decrease: { label: '↓ Decrease', color: 'text-accent', bg: 'bg-accent/10' },
                  optimal:  { label: '✓ Optimal',  color: 'text-muted',  bg: 'bg-card-border/30' },
                }[direction];

                return (
                  <div key={pair.key} className="grid items-center gap-4 px-1 py-2 rounded hover:bg-background/30 transition-colors text-sm" style={{ gridTemplateColumns: 'auto 1fr 1fr 1fr 1fr 1fr' }}>
                    <span className="font-medium w-16">{pair.label}</span>
                    <span className="text-xs text-muted tabular-nums">{count} trades</span>
                    <div className="text-xs">
                      <span className="tabular-nums font-medium">
                        {currentExit > 0 ? `${currencySymbol}${currentExit}` : 'Off'}
                      </span>
                      {currentExit > 0 && (
                        <span className={`ml-1.5 ${winRateAtCurrent >= 90 ? 'text-green' : winRateAtCurrent >= 75 ? 'text-accent' : 'text-red'}`}>
                          {hitsAtCurrent} hit
                        </span>
                      )}
                    </div>
                    <div className="text-xs">
                      <span className="tabular-nums font-medium">{currencySymbol}{safeExit}</span>
                      <span className="ml-1 text-muted">({a.safeExitPct}% of notional)</span>
                      <span className="ml-1.5 text-green">{winRateAtSafe}% hit</span>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded w-fit ${directionConfig.color} ${directionConfig.bg}`}>
                      {directionConfig.label}
                      {direction !== 'optimal' && ` ${currencySymbol}${currentExit} → ${currencySymbol}${safeExit}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* SSL / Domain */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">SSL / Domain</h2>
        <p className="text-xs text-muted mb-5">
          Configure your server&apos;s domain. Caddy will automatically obtain and renew a Let&apos;s Encrypt certificate — no manual steps needed.
        </p>

        <div className="max-w-sm">
          <label className="block text-xs text-muted mb-1">Webhook Domain</label>
          <input
            type="text"
            value={sslDomain}
            onChange={(e) => setSslDomain(e.target.value)}
            className="w-full bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
            placeholder="webhook.example.com"
          />
          <p className="text-[11px] text-muted mt-1">DNS A record must point to this server&apos;s IP before applying.</p>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={applySsl}
            disabled={sslChecking}
            className="px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {sslChecking ? 'Applying…' : 'Apply & Get Certificate'}
          </button>
          {sslMsg && (
            <span className={`text-sm ${sslMsg.startsWith('Applied') ? 'text-green' : 'text-red'}`}>
              {sslMsg}
            </span>
          )}
        </div>

        {/* Certificate Status */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs text-muted uppercase tracking-wider">Certificate Status</h3>
            <button
              onClick={checkSslStatus}
              disabled={sslChecking}
              className="text-xs text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
            >
              {sslChecking ? 'Checking…' : 'Check Status'}
            </button>
          </div>

          {sslStatus === null && (
            <div className="border border-card-border rounded p-3 text-xs text-muted">
              Click &ldquo;Check Status&rdquo; to probe the current certificate.
            </div>
          )}

          {sslStatus !== null && !sslStatus.configured && (
            <div className="border border-card-border rounded p-3 text-xs text-muted">
              No domain configured. Enter a domain above and click Apply.
            </div>
          )}

          {sslStatus !== null && sslStatus.configured && !sslStatus.hasCert && (
            <div className="border border-yellow/30 bg-yellow/5 rounded p-3 text-xs">
              <p className="text-yellow font-medium mb-1">No certificate found</p>
              <p className="text-muted">
                {sslStatus.error
                  ? sslStatus.error
                  : `Ensure the DNS A record for ${sslStatus.domain} points to this server, then click Apply.`}
              </p>
            </div>
          )}

          {sslStatus !== null && sslStatus.configured && sslStatus.hasCert && (
            <div className={`border rounded p-3 text-xs space-y-1 ${
              (sslStatus.daysUntilExpiry ?? 0) > 14
                ? 'border-green/30 bg-green/5'
                : 'border-yellow/30 bg-yellow/5'
            }`}>
              <p className={`font-medium ${(sslStatus.daysUntilExpiry ?? 0) > 14 ? 'text-green' : 'text-yellow'}`}>
                {(sslStatus.daysUntilExpiry ?? 0) > 14 ? '✓ Certificate active' : '⚠ Certificate expiring soon'}
              </p>
              <p className="text-muted">Domain: <span className="text-foreground font-mono">{sslStatus.domain}</span></p>
              <p className="text-muted">Issuer: <span className="text-foreground">{sslStatus.issuer}</span></p>
              {sslStatus.validTo && (
                <p className="text-muted">
                  Expires: <span className="text-foreground">
                    {new Date(sslStatus.validTo).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {' '}({sslStatus.daysUntilExpiry} days)
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* IP Allowlist */}
      <div className="bg-card border border-card-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider">IP Allowlist</h2>
          <button
            onClick={() => setIpEnabled((v) => !v)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ipEnabled ? 'bg-accent' : 'bg-card-border'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ipEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="text-xs text-muted mb-5">
          When enabled, only listed IP addresses can access the app. Applies to all routes including the dashboard.
          {ipEnabled && <span className="text-yellow ml-1 font-medium">Ensure your own IP is listed before saving.</span>}
        </p>

        {/* Quick-add TradingView IPs */}
        <div className="mb-4">
          <button
            onClick={hasTvIps ? removeTvIps : addTvIps}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${hasTvIps ? 'border-accent/40 text-accent bg-accent/10 hover:bg-accent/20' : 'border-card-border text-muted hover:text-foreground hover:border-foreground/30'}`}
          >
            {hasTvIps ? '✓ TradingView IPs added' : '+ Add TradingView webhook IPs'}
          </button>
          <p className="text-[11px] text-muted mt-1">52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7</p>
        </div>

        <div className="mb-4">
          <button
            onClick={hasLocalIps ? removeLocalIps : addLocalIps}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${hasLocalIps ? 'border-accent/40 text-accent bg-accent/10 hover:bg-accent/20' : 'border-card-border text-muted hover:text-foreground hover:border-foreground/30'}`}
          >
            {hasLocalIps ? '✓ Local network added' : '+ Add local network (RFC 1918)'}
          </button>
          <p className="text-[11px] text-muted mt-1">127.0.0.1, 10.0.0.0/8, 192.168.0.0/16</p>
        </div>

        {/* Custom IP / hostname input */}
        <div className="flex gap-2 mb-4 max-w-sm">
          <input
            type="text"
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addIp()}
            className="flex-1 bg-background border border-card-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
            placeholder="e.g. 203.0.113.42 or ddns.example.com"
          />
          <button
            onClick={addIp}
            className="px-3 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors"
          >
            Add
          </button>
        </div>
        <p className="text-[11px] text-muted -mt-3 mb-4">Supports IPs, CIDR ranges, and dynamic DNS hostnames (resolved every 60s).</p>

        {/* IP list */}
        {ipList.length > 0 && (
          <ul className="space-y-1 mb-5 max-w-sm">
            {ipList.map((ip) => {
              const isDns = /[a-zA-Z]/.test(ip) && ip.includes('.');
              const resolvedIps = isDns ? dnsResolved[ip] : undefined;
              return (
                <li key={ip} className="flex items-center justify-between bg-background border border-card-border rounded px-3 py-1.5">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="text-sm font-mono text-foreground truncate">{ip}</span>
                    {isDns && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">DNS</span>}
                    {isDns && resolvedIps !== undefined && (
                      <span className="text-[11px] text-muted font-mono">
                        {resolvedIps.length > 0 ? `\u2192 ${resolvedIps.join(', ')}` : '\u2192 unresolved'}
                      </span>
                    )}
                  </div>
                  <button onClick={() => removeIp(ip)} className="text-muted hover:text-red transition-colors text-xs ml-4 shrink-0">Remove</button>
                </li>
              );
            })}
          </ul>
        )}

        {ipList.length === 0 && (
          <p className="text-xs text-muted mb-5">No IPs configured. Add at least one before enabling.</p>
        )}

        <button
          onClick={saveIpAllowlist}
          disabled={saving}
          className="px-5 py-2 bg-accent text-background text-sm font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Allowlist'}
        </button>
        {ipMsg && (
          <span className={`ml-3 text-sm ${ipMsg === 'Saved' ? 'text-green' : 'text-red'}`}>{ipMsg}</span>
        )}
      </div>
    </div>
  );
}
