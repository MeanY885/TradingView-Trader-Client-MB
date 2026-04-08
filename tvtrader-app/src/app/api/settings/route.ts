import { NextResponse } from 'next/server';
import { getSettings, updateSetting } from '../../../lib/db';
import { getBroker } from '../../../lib/brokers/factory';

const ALLOWED_KEYS = [
  'trading_mode',
  'leverage',
  'max_slippage_pips',
  'max_slippage_pips_EUR_USD',
  'max_slippage_pips_XAU_USD',
  'max_slippage_pips_NZD_JPY',
  'risk_pct_EUR_USD',
  'risk_pct_XAU_USD',
  'risk_pct_NZD_JPY',
  'profit_target_EUR_USD',
  'profit_target_XAU_USD',
  'profit_target_NZD_JPY',
  'loss_target_EUR_USD',
  'loss_target_XAU_USD',
  'loss_target_NZD_JPY',
  'enabled_EUR_USD',
  'enabled_XAU_USD',
  'enabled_NZD_JPY',
  // Oanda credentials
  'practice_api_key',
  'practice_account_id',
  'live_api_key',
  'live_account_id',
  // Interactive Brokers (Client Portal Gateway)
  'ib_gateway_url',
  'ib_account_id',
  'ib_username',
  'ib_password',
  // Broker selection
  'broker',
  'risk_percentage', // fallback for old DB rows
  'initial_balance',
  'webhook_domain',
  'ip_whitelist_enabled',
  'ip_whitelist',
  'account_currency',
];

const PER_PAIR_DEFAULTS: Record<string, string> = {
  risk_pct_EUR_USD: '90',
  risk_pct_XAU_USD: '5',
  risk_pct_NZD_JPY: '5',
  enabled_EUR_USD: 'true',
  enabled_XAU_USD: 'true',
  enabled_NZD_JPY: 'true',
  max_slippage_pips_EUR_USD: '3',
  max_slippage_pips_XAU_USD: '10',
  max_slippage_pips_NZD_JPY: '5',
};

export async function GET() {
  try {
    const raw = await getSettings();

    // Seed per-pair risk defaults on first load
    for (const [key, val] of Object.entries(PER_PAIR_DEFAULTS)) {
      if (!raw[key]) {
        await updateSetting(key, val);
        raw[key] = val;
      }
    }

    // Auto-seed account_currency from broker on first use
    if (!raw.account_currency) {
      try {
        const broker = await getBroker();
        const acct = await broker.getAccountSummary();
        const ccy = acct?.currency || 'GBP';
        await updateSetting('account_currency', ccy);
        raw.account_currency = ccy;
      } catch {
        raw.account_currency = 'GBP';
      }
    }

    const hasPracticeKey = !!(raw.practice_api_key || process.env.OANDA_API_KEY_PRACTICE);
    const hasLiveKey = !!(raw.live_api_key || process.env.OANDA_API_KEY_LIVE);

    // Strip secret keys from response
    const { practice_api_key, live_api_key, ib_password, ...rest } = raw;
    void practice_api_key; void live_api_key; void ib_password;

    const hasIbCredentials = !!(raw.ib_username && raw.ib_password);

    return NextResponse.json({
      ...rest,
      broker: raw.broker || 'oanda',
      practice_account_id: raw.practice_account_id || process.env.OANDA_ACCOUNT_ID_PRACTICE || '',
      live_account_id: raw.live_account_id || process.env.OANDA_ACCOUNT_ID_LIVE || '',
      hasPracticeKey,
      hasLiveKey,
      // IB gateway fields
      ib_gateway_url: raw.ib_gateway_url || process.env.IB_GATEWAY_URL || 'http://localhost:5000',
      ib_account_id: raw.ib_account_id || '',
      ib_username: raw.ib_username || '',
      hasIbCredentials,
    });
  } catch (e) {
    console.error('Settings fetch error:', e);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Record<string, string>;

    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.includes(key)) continue;

      if (key === 'broker') {
        const validBrokers = ['oanda', 'interactive_brokers'];
        if (!validBrokers.includes(value)) {
          return NextResponse.json({ error: `broker must be one of: ${validBrokers.join(', ')}` }, { status: 400 });
        }
      }

      if (key === 'trading_mode' && value !== 'practice' && value !== 'live') {
        return NextResponse.json({ error: 'Invalid trading mode' }, { status: 400 });
      }

      if (key === 'leverage') {
        const v = parseInt(value, 10);
        if (isNaN(v) || v < 1 || v > 30) {
          return NextResponse.json({ error: 'Leverage must be 1-30' }, { status: 400 });
        }
      }

      if (key === 'max_slippage_pips' || key.startsWith('max_slippage_pips_')) {
        const v = parseFloat(value);
        if (isNaN(v) || v < 0 || v > 200) {
          return NextResponse.json({ error: 'Max slippage must be 0-200' }, { status: 400 });
        }
      }

      if (key === 'risk_percentage') {
        const v = parseFloat(value);
        if (isNaN(v) || v < 0.1 || v > 100) {
          return NextResponse.json({ error: 'Risk must be 0.1-100' }, { status: 400 });
        }
      }

      if (key.startsWith('risk_pct_')) {
        const v = parseFloat(value);
        if (isNaN(v) || v < 0.1 || v > 100) {
          return NextResponse.json({ error: `${key} must be 0.1-100` }, { status: 400 });
        }
      }

      if (key.startsWith('profit_target_')) {
        const v = parseFloat(value);
        if (isNaN(v) || v < 0) {
          return NextResponse.json({ error: 'Profit target must be 0 or greater (0 = disabled)' }, { status: 400 });
        }
      }

      if (key.startsWith('loss_target_')) {
        const v = parseFloat(value);
        if (isNaN(v) || v < 0) {
          return NextResponse.json({ error: 'Loss target must be 0 or greater (0 = disabled)' }, { status: 400 });
        }
      }

      if (key.startsWith('enabled_')) {
        if (value !== 'true' && value !== 'false') {
          return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
        }
      }

      if (key === 'ip_whitelist_enabled') {
        if (value !== 'true' && value !== 'false') {
          return NextResponse.json({ error: 'ip_whitelist_enabled must be true or false' }, { status: 400 });
        }
      }

      if (key === 'ip_whitelist') {
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) throw new Error();
        } catch {
          return NextResponse.json({ error: 'ip_whitelist must be a JSON array of IP strings' }, { status: 400 });
        }
      }

      if (key === 'account_currency') {
        const supported = ['GBP', 'USD', 'EUR', 'JPY', 'AUD', 'CAD', 'CHF'];
        if (!supported.includes(value.toUpperCase())) {
          return NextResponse.json({ error: `account_currency must be one of: ${supported.join(', ')}` }, { status: 400 });
        }
      }

      if (key === 'webhook_domain') {
        const v = String(value).trim();
        if (v && (v.includes(' ') || v.startsWith('http') || !v.includes('.'))) {
          return NextResponse.json({ error: 'webhook_domain must be a plain hostname (e.g. webhook.example.com)' }, { status: 400 });
        }
      }

      if (key === 'ib_gateway_url') {
        const v = String(value).trim();
        if (v && !v.startsWith('http://') && !v.startsWith('https://')) {
          return NextResponse.json({ error: 'ib_gateway_url must start with http:// or https://' }, { status: 400 });
        }
      }

      // Skip blank secret updates (keep existing)
      const secretKeys = ['practice_api_key', 'live_api_key', 'ib_password'];
      if (secretKeys.includes(key) && !String(value).trim()) {
        continue;
      }

      await updateSetting(key, String(value));
    }

    // Return same shape as GET so the frontend state stays consistent
    const updated = await getSettings();
    const hasPracticeKey = !!(updated.practice_api_key || process.env.OANDA_API_KEY_PRACTICE);
    const hasLiveKey = !!(updated.live_api_key || process.env.OANDA_API_KEY_LIVE);

    const { practice_api_key: _pk, live_api_key: _lk, ib_password: _ip, ...rest } = updated;
    void _pk; void _lk; void _ip;

    const hasIbCredentials = !!(updated.ib_username && updated.ib_password);

    return NextResponse.json({
      ...rest,
      broker: updated.broker || 'oanda',
      practice_account_id: updated.practice_account_id || process.env.OANDA_ACCOUNT_ID_PRACTICE || '',
      live_account_id: updated.live_account_id || process.env.OANDA_ACCOUNT_ID_LIVE || '',
      hasPracticeKey,
      hasLiveKey,
      ib_gateway_url: updated.ib_gateway_url || process.env.IB_GATEWAY_URL || 'http://localhost:5000',
      ib_account_id: updated.ib_account_id || '',
      ib_username: updated.ib_username || '',
      hasIbCredentials,
    });
  } catch (e) {
    console.error('Settings update error:', e);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
