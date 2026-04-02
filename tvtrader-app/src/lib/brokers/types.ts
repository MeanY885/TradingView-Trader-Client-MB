/**
 * brokers/types.ts
 *
 * Broker adapter interface and normalized return types.
 * All brokers must implement this interface to ensure feature parity.
 * Return types use numbers (not strings) and canonical instrument format (BASE_QUOTE).
 */

export type BrokerType = 'oanda' | 'interactive_brokers';

export interface AccountSummary {
  balance: number;
  nav: number;
  marginAvailable: number;
  unrealizedPL: number;
  currency: string;
  openTradeCount: number;
  marginUsed: number;
}

export interface PriceQuote {
  instrument: string; // Canonical format: BASE_QUOTE
  ask: number;
  bid: number;
}

export interface BrokerTrade {
  brokerTradeId: string;
  instrument: string; // Canonical format
  units: number; // Positive = long, negative = short
  entryPrice: number;
  unrealizedPL: number;
  state: 'OPEN' | 'CLOSED';
  takeProfitPrice?: number;
  stopLossPrice?: number;
  highestPrice?: number;
  lowestPrice?: number;
  averageClosePrice?: number;
  realizedPL?: number;
  closeTime?: string;
  takeProfitFilled?: boolean;
  stopLossFilled?: boolean;
  initialMarginRequired?: number;
}

export interface OrderResult {
  filled: boolean;
  brokerTradeId?: string;
  fillPrice?: number;
  rejectedReason?: string;
  realizedPL?: number;
}

export interface CloseResult {
  fillPrice?: number;
  realizedPL?: number;
}

export interface TransactionRecord {
  type: string;
  brokerTradeId?: string;
  tradesClosed?: Array<{ brokerTradeId: string; price?: number; realizedPL?: number }>;
  reason?: string;
  price?: number;
  realizedPL?: number;
  time?: string;
}

export interface CandleData {
  time: string;
  midHigh: number;
  midLow: number;
}

export interface BrokerAdapter {
  readonly brokerName: BrokerType;

  // Connection lifecycle (no-op for stateless REST brokers like Oanda)
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Account
  getAccountSummary(): Promise<AccountSummary>;

  // Pricing
  getPricing(instrument: string): Promise<PriceQuote>;
  getPricingMulti(instruments: string[]): Promise<PriceQuote[]>;

  // Trades
  getOpenTrades(): Promise<BrokerTrade[]>;
  getTradeDetails(brokerTradeId: string): Promise<BrokerTrade>;
  getClosedTrades(count?: number): Promise<BrokerTrade[]>;
  getTransactionsSinceId(id: string): Promise<TransactionRecord[]>;

  // Order execution
  placeMarketOrder(
    instrument: string,
    units: number, // Positive = buy, negative = sell
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<OrderResult>;

  closeTrade(brokerTradeId: string): Promise<CloseResult>;

  // Market data
  getCandles(
    instrument: string,
    from: string,
    to: string,
    granularity?: string,
  ): Promise<CandleData[]>;
}
