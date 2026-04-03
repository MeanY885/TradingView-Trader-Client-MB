/**
 * interactive-brokers/client.ts
 *
 * Low-level HTTP client for the IB Client Portal Gateway REST API.
 * Uses session-based auth (no Bearer tokens) — the gateway manages
 * authentication via manual browser login.
 *
 * The gateway uses a self-signed SSL certificate, so we disable
 * TLS verification for requests to it.
 */

import { BrokerError, BrokerAuthError, BrokerConnectionError } from '../errors';
import { ibGatewayFetch } from './gateway-fetch';

export interface IBClientConfig {
  gatewayUrl: string;  // e.g. http://localhost:5000 or http://ib-gateway:5000
  accountId: string;
}

export class IBClient {
  private config: IBClientConfig;

  constructor(config: IBClientConfig) {
    this.config = config;
  }

  get accountId(): string {
    return this.config.accountId;
  }

  get gatewayUrl(): string {
    return this.config.gatewayUrl;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.config.gatewayUrl}${path}`;
    let res: Response;
    try {
      res = await ibGatewayFetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch (e) {
      throw new BrokerConnectionError(
        'interactive_brokers',
        `Cannot reach IB Gateway at ${this.config.gatewayUrl}: ${e}`,
        e,
      );
    }

    if (res.status === 401) {
      throw new BrokerAuthError(
        'interactive_brokers',
        'IB Gateway session expired. Please log in again at the gateway URL.',
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new BrokerError(
        `IB Gateway error ${res.status}: ${text}`,
        'interactive_brokers',
        `HTTP_${res.status}`,
        res.status >= 500,
      );
    }

    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // --- Session ---

  async authStatus(): Promise<{ authenticated: boolean; connected: boolean; competing: boolean }> {
    return this.request('/v1/api/iserver/auth/status', { method: 'POST' });
  }

  async tickle(): Promise<void> {
    await this.request<unknown>('/v1/api/tickle', { method: 'POST' });
  }

  async ssoValidate(): Promise<void> {
    await this.request('/v1/api/sso/validate');
  }

  async logout(): Promise<void> {
    await this.request('/v1/api/logout', { method: 'POST' });
  }

  // --- Account ---

  async getAccounts(): Promise<IBAccount[]> {
    const data = await this.request<{ accounts: string[] } | IBAccount[]>(
      '/v1/api/portfolio/accounts'
    );
    if (Array.isArray(data)) return data;
    return [];
  }

  async getAccountSummary(): Promise<IBAccountSummary> {
    return this.request<IBAccountSummary>(
      `/v1/api/portfolio/${this.config.accountId}/summary`
    );
  }

  async getAccountLedger(): Promise<Record<string, IBLedgerEntry>> {
    return this.request<Record<string, IBLedgerEntry>>(
      `/v1/api/portfolio/${this.config.accountId}/ledger`
    );
  }

  // --- Positions ---

  async getPositions(): Promise<IBPosition[]> {
    return this.request<IBPosition[]>(
      `/v1/api/portfolio/${this.config.accountId}/positions/0`
    );
  }

  // --- Order Warnings ---

  async suppressOrderWarnings(): Promise<void> {
    // Suppress common IB order warnings that block automated bracket orders:
    // o10331 = stop order risk warning, o383 = size limit warning
    await this.request<{ status: string }>(
      '/v1/api/iserver/questions/suppress',
      {
        method: 'POST',
        body: JSON.stringify({ messageIds: ['o10331', 'o383'] }),
      }
    ).catch((e) => console.warn('[IB] Failed to suppress order warnings:', e));
  }

  // --- Contract Search ---

  async searchContract(symbol: string, secType: string): Promise<IBContractSearchResult[]> {
    return this.request<IBContractSearchResult[]>(
      '/v1/api/iserver/secdef/search',
      {
        method: 'POST',
        body: JSON.stringify({ symbol, secType }),
      }
    );
  }

  // --- Market Data ---

  async getMarketDataSnapshot(conids: number[], fields: string[]): Promise<IBMarketDataSnapshot[]> {
    const conidStr = conids.join(',');
    const fieldStr = fields.join(',');
    return this.request<IBMarketDataSnapshot[]>(
      `/v1/api/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fieldStr}`
    );
  }

  async getLiveQuote(conid: number): Promise<IBMarketDataSnapshot> {
    const snapshots = await this.getMarketDataSnapshot([conid], ['84', '86']);
    return snapshots[0] || {};
  }

  // --- Orders ---

  async placeOrder(order: IBOrderRequest): Promise<IBOrderResponse[]> {
    return this.request<IBOrderResponse[]>(
      `/v1/api/iserver/account/${this.config.accountId}/orders`,
      {
        method: 'POST',
        body: JSON.stringify({ orders: [order] }),
      }
    );
  }

  async placeBracketOrder(orders: IBOrderRequest[]): Promise<IBOrderResponse[]> {
    return this.request<IBOrderResponse[]>(
      `/v1/api/iserver/account/${this.config.accountId}/orders`,
      {
        method: 'POST',
        body: JSON.stringify({ orders }),
      }
    );
  }

  /**
   * Confirm an order that requires a reply.
   * IB Gateway returns a message with a replyId that must be confirmed.
   */
  async confirmOrder(replyId: string): Promise<IBOrderResponse[]> {
    return this.request<IBOrderResponse[]>(
      `/v1/api/iserver/reply/${replyId}`,
      {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      }
    );
  }

  async getOpenOrders(): Promise<IBOpenOrder[]> {
    const data = await this.request<{ orders: IBOpenOrder[] } | IBOpenOrder[]>(
      '/v1/api/iserver/account/orders'
    );
    // API returns { orders: [...] } wrapper
    if (Array.isArray(data)) return data;
    return data.orders || [];
  }

  async cancelOrder(orderId: string): Promise<{ msg: string }> {
    return this.request<{ msg: string }>(
      `/v1/api/iserver/account/${this.config.accountId}/order/${orderId}`,
      { method: 'DELETE' }
    );
  }

  // --- Trades / Executions ---

  async getTrades(): Promise<IBExecution[]> {
    return this.request<IBExecution[]>('/v1/api/iserver/account/trades');
  }
}

// --- IB Gateway Response Types ---

export interface IBAccount {
  id: string;
  accountId: string;
  accountTitle: string;
  displayName: string;
  accountAlias: string;
  accountStatus: number;
  currency: string;
  type: string;
  tradingType: string;
  covestor: boolean;
  parent?: { mmc: string[]; accountId: string; isMParent: boolean; isMChild: boolean };
}

export interface IBLedgerEntry {
  commoditymarketvalue: number;
  futuremarketvalue: number;
  settledcash: number;
  exchangerate: number;
  sessionid: number;
  cashbalance: number;
  corporatebondsmarketvalue: number;
  warrantsmarketvalue: number;
  netliquidationvalue: number;
  interest: number;
  unrealizedpnl: number;
  stockmarketvalue: number;
  moneyfunds: number;
  currency: string;
  realizedpnl: number;
  funds: number;
  acctcode: string;
  issueroptionsmarketvalue: number;
  key: string;
  timestamp: number;
  severity: number;
}

export interface IBAccountSummary {
  [key: string]: IBAccountField;
}

export interface IBAccountField {
  amount: number;
  currency: string;
  isNull: boolean;
  severity: number;
  timestamp: number;
  value: string;
}

export interface IBPosition {
  acctId: string;
  conid: number;
  contractDesc: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  currency: string;
  avgCost: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  exchs: string | null;
  expiry: string | null;
  putOrCall: string | null;
  multiplier: number | null;
  strike: number;
  exerciseStyle: string | null;
  assetClass: string;
  model: string;
}

export interface IBContractSearchResult {
  conid: number;
  companyHeader: string;
  companyName: string;
  symbol: string;
  description: string;
  restricted: string;
  fop: string;
  opt: string;
  war: string;
  sections: Array<{ secType: string; exchange: string }>;
}

export interface IBOrderRequest {
  conid: number;
  orderType: string; // 'MKT', 'LMT', 'STP', etc.
  side: 'BUY' | 'SELL';
  quantity: number;
  tif: string; // 'GTC', 'DAY', 'IOC', 'FOK'
  price?: number;
  auxPrice?: number; // Stop price
  listingExchange?: string;
  outsideRTH?: boolean;
  referrer?: string;
  cOID?: string; // Client order ID
  parentId?: string; // For bracket orders
  isClose?: boolean;
  secType?: string; // e.g. 'CASH'
}

export interface IBOrderResponse {
  order_id: string;
  order_status: string;
  encrypt_message?: string;
  // Confirmation prompt fields — must call confirmOrder(id) to proceed
  id?: string;
  message?: string[];
  isSuppressed?: boolean;
  messageIds?: string[];
}

export interface IBOpenOrder {
  acct: string;
  conid: number;
  orderId: number;
  orderDesc: string;
  description1: string;
  status: string;
  origOrderType: string; // "MARKET", "LIMIT", "STOP"
  orderType: string; // "Market", "Limit", "Stop"
  side: string;
  price: number;
  auxPrice?: number; // Stop trigger price for STOP orders
  stop_price?: number; // Also stop trigger price (duplicate of auxPrice)
  parentId?: number;
  bgColor: string;
  fgColor: string;
  remainingQuantity: number;
  filledQuantity: number;
  avgPrice: number;
  lastExecutionTime_r: number;
  order_ref?: string;
}

export interface IBMarketDataSnapshot {
  conid: number;
  // Field IDs: 31=Last, 84=Bid, 85=AskSize, 86=Ask, 7295=Open, etc.
  [key: string]: unknown;
  '31'?: string; // Last Price
  '84'?: string; // Bid
  '86'?: string; // Ask
}

export interface IBExecution {
  execution_id: string;
  symbol: string;
  side: string; // "B" or "S" (not "BUY"/"SELL")
  order_description: string; // e.g. "Sold 100 @ 1.15265 on SMART"
  trade_time: string;
  trade_time_r: number;
  size: number;
  price: string;
  exchange: string;
  commission: string;
  net_amount: number;
  account: string;
  conid: number;
  order_id: number; // Matches orderId in open orders — used to classify TP/SL
  clearing_id: string;
  clearing_name: string;
}
