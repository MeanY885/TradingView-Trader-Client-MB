import { getSettings } from './db';

function getOandaConfig(mode: string, settings: Record<string, string> = {}) {
  if (mode === 'live') {
    return {
      apiKey: settings.live_api_key || process.env.OANDA_API_KEY_LIVE || '',
      accountId: settings.live_account_id || process.env.OANDA_ACCOUNT_ID_LIVE || '',
      baseUrl: 'https://api-fxtrade.oanda.com',
    };
  }
  return {
    apiKey: settings.practice_api_key || process.env.OANDA_API_KEY_PRACTICE || '',
    accountId: settings.practice_account_id || process.env.OANDA_ACCOUNT_ID_PRACTICE || '',
    baseUrl: 'https://api-fxpractice.oanda.com',
  };
}

async function getConfig() {
  const settings = await getSettings();
  const mode = settings.trading_mode || 'practice';
  return getOandaConfig(mode, settings);
}

async function oandaFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const config = await getConfig();
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Oanda API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAccountId(): Promise<string> {
  const config = await getConfig();
  return config.accountId;
}

export async function getAccountSummary(): Promise<{ account: { balance: string; NAV: string; marginAvailable: string; unrealizedPL: string; currency: string; openTradeCount: number; marginUsed: string } }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/summary`) as Promise<{ account: { balance: string; NAV: string; marginAvailable: string; unrealizedPL: string; currency: string; openTradeCount: number; marginUsed: string } }>;
}

export async function getOpenTrades(): Promise<{ trades: Array<{ id: string; instrument: string; [key: string]: unknown }> }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/openTrades`) as Promise<{ trades: Array<{ id: string; instrument: string; [key: string]: unknown }> }>;
}

export async function getTradeDetails(tradeId: string): Promise<{ trade: { id: string; state: string; unrealizedPL: string; averageClosePrice?: string; realizedPL?: string; closeTime?: string; highestPrice?: string; lowestPrice?: string; takeProfitOrder?: { state: string }; stopLossOrder?: { state: string } } }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/trades/${tradeId}`) as Promise<{ trade: { id: string; state: string; unrealizedPL: string; averageClosePrice?: string; realizedPL?: string; closeTime?: string; highestPrice?: string; lowestPrice?: string; takeProfitOrder?: { state: string }; stopLossOrder?: { state: string } } }>;
}

export async function getPricing(instrument: string): Promise<{ prices: Array<{ instrument: string; asks: Array<{ price: string }>; bids: Array<{ price: string }> }> }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/pricing?instruments=${instrument}`) as Promise<{ prices: Array<{ instrument: string; asks: Array<{ price: string }>; bids: Array<{ price: string }> }> }>;
}

export async function placeMarketOrder(instrument: string, units: string, tp: string, sl: string): Promise<{ orderFillTransaction?: { tradeOpened?: { tradeID: string; price: string }; price?: string; pl?: string }; orderCancelTransaction?: { reason: string } }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/orders`, {
    method: 'POST',
    body: JSON.stringify({
      order: {
        type: 'MARKET',
        instrument,
        units,
        timeInForce: 'FOK',
        takeProfitOnFill: { price: tp },
        stopLossOnFill: { price: sl },
      },
    }),
  }) as Promise<{ orderFillTransaction?: { tradeOpened?: { tradeID: string; price: string }; price?: string; pl?: string }; orderCancelTransaction?: { reason: string } }>;
}

export async function getClosedTrades(count = 50): Promise<{ trades: Array<{ id: string; averageClosePrice?: string; realizedPL?: string; closeTime?: string; highestPrice?: string; lowestPrice?: string; takeProfitOrder?: { state: string }; stopLossOrder?: { state: string } }> }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/trades?state=CLOSED&count=${count}`) as Promise<{ trades: Array<{ id: string; averageClosePrice?: string; realizedPL?: string; closeTime?: string; highestPrice?: string; lowestPrice?: string; takeProfitOrder?: { state: string }; stopLossOrder?: { state: string } }> }>;
}

export async function getTransactionsSinceId(id: string): Promise<{ transactions: Array<{ type: string; tradeID?: string; tradesClosed?: Array<{ tradeID: string; price?: string; realizedPL?: string }>; reason?: string; price?: string; pl?: string; time?: string }> }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/transactions/sinceid?id=${id}`) as Promise<{ transactions: Array<{ type: string; tradeID?: string; tradesClosed?: Array<{ tradeID: string; price?: string; realizedPL?: string }>; reason?: string; price?: string; pl?: string; time?: string }> }>;
}

export async function closeTrade(tradeId: string): Promise<{ orderFillTransaction?: { price?: string; pl?: string } }> {
  const accountId = await getAccountId();
  return oandaFetch(`/v3/accounts/${accountId}/trades/${tradeId}/close`, {
    method: 'PUT',
    body: JSON.stringify({ units: 'ALL' }),
  }) as Promise<{ orderFillTransaction?: { price?: string; pl?: string } }>;
}

export async function getCandles(instrument: string, from: string, to: string, granularity = 'M1'): Promise<{ candles: Array<{ time: string; mid: { h: string; l: string } }> }> {
  const params = new URLSearchParams({ price: 'M', granularity, from, to });
  return oandaFetch(`/v3/instruments/${instrument}/candles?${params.toString()}`) as Promise<{ candles: Array<{ time: string; mid: { h: string; l: string } }> }>;
}
