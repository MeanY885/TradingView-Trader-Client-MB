/**
 * interactive-brokers/client.ts
 *
 * Low-level HTTP client for the IB Web API.
 * Handles request signing, error handling, and response parsing.
 */

import { IBAuthManager } from './auth';
import { BrokerError, BrokerAuthError, BrokerConnectionError } from '../errors';

export interface IBClientConfig {
  baseUrl: string;
  accountId: string;
  authManager: IBAuthManager;
}

export class IBClient {
  private config: IBClientConfig;

  constructor(config: IBClientConfig) {
    this.config = config;
  }

  get accountId(): string {
    return this.config.accountId;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const { accessToken } = await this.config.authManager.getAccessToken();
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    retryOnAuth = true,
  ): Promise<T> {
    const headers = await this.getAuthHeaders();
    const url = `${this.config.baseUrl}${path}`;

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers },
      });
    } catch (e) {
      throw new BrokerConnectionError('interactive_brokers', `Network error: ${e}`, e);
    }

    if (res.status === 401 && retryOnAuth) {
      // Token expired or session killed — try refreshing once
      console.warn('[IB-CLIENT] 401 received — attempting token refresh');
      this.config.authManager.invalidate();
      return this.request(path, options, false);
    }

    if (res.status === 401) {
      throw new BrokerAuthError('interactive_brokers', 'Authentication failed after token refresh');
    }

    if (!res.ok) {
      const text = await res.text();
      throw new BrokerError(
        `IB API error ${res.status}: ${text}`,
        'interactive_brokers',
        `HTTP_${res.status}`,
        res.status >= 500,
      );
    }

    return res.json() as Promise<T>;
  }

  // --- Account ---

  async getAccountSummary(): Promise<IBAccountSummary> {
    const data = await this.request<IBAccountSummaryResponse>(
      `/v1/api/portfolio/${this.config.accountId}/summary`
    );
    return data;
  }

  // --- Positions ---

  async getPositions(): Promise<IBPosition[]> {
    return this.request<IBPosition[]>(
      `/v1/api/portfolio/${this.config.accountId}/positions/0`
    );
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

  async getOpenOrders(): Promise<IBOpenOrder[]> {
    return this.request<IBOpenOrder[]>('/v1/api/iserver/account/orders');
  }

  async cancelOrder(orderId: string): Promise<{ msg: string }> {
    return this.request<{ msg: string }>(
      `/v1/api/iserver/account/${this.config.accountId}/order/${orderId}`,
      { method: 'DELETE' }
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

  // --- Trades / Executions ---

  async getTrades(): Promise<IBExecution[]> {
    return this.request<IBExecution[]>('/v1/api/iserver/account/trades');
  }

  // --- Session ---

  async tickle(): Promise<void> {
    await this.request<unknown>('/v1/api/tickle', { method: 'POST' });
  }

  async authStatus(): Promise<{ authenticated: boolean; competing: boolean }> {
    return this.request<{ authenticated: boolean; competing: boolean }>('/v1/api/iserver/auth/status', { method: 'POST' });
  }
}

// --- IB API Response Types ---

export interface IBAccountSummary {
  [key: string]: IBAccountField;
}

export type IBAccountSummaryResponse = IBAccountSummary;

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
}

export interface IBOrderResponse {
  order_id: string;
  order_status: string;
  encrypt_message?: string;
  // Confirmation may require reply
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
  origOrderType: string;
  side: string;
  price: number;
  bgColor: string;
  fgColor: string;
  remainingQuantity: number;
  filledQuantity: number;
  avgPrice: number;
  lastExecutionTime_r: number;
  orderRef: string;
}

export interface IBMarketDataSnapshot {
  conid: number;
  // Field IDs: 31=Last, 84=Bid, 85=AskSize, 86=Ask, 7295=Open, etc.
  [key: string]: unknown;
  // Common fields
  '31'?: string; // Last Price
  '84'?: string; // Bid
  '86'?: string; // Ask
}

export interface IBExecution {
  execution_id: string;
  symbol: string;
  side: string;
  order_description: string;
  trade_time: string;
  trade_time_r: number;
  size: number;
  price: string;
  exchange: string;
  commission: string;
  net_amount: number;
  account: string;
  conid: number;
  clearing_id: string;
  clearing_name: string;
}
