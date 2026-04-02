/**
 * interactive-brokers/adapter.ts
 *
 * Implements BrokerAdapter for Interactive Brokers Web API.
 * Translates between the normalized adapter interface and IB-specific API calls.
 */

import {
  BrokerAdapter,
  AccountSummary,
  PriceQuote,
  BrokerTrade,
  OrderResult,
  CloseResult,
  TransactionRecord,
  CandleData,
} from '../types';
import {
  BrokerError,
  InsufficientMarginError,
  OrderRejectedError,
  InstrumentNotSupportedError,
} from '../errors';
import { INSTRUMENTS, InstrumentConfig } from '../instruments';
import { IBClient, IBOrderRequest } from './client';
import { IBAuthManager } from './auth';
import { IBKeepalive } from './keepalive';
import { getSettings } from '../../db';

export class IBAdapter implements BrokerAdapter {
  readonly brokerName = 'interactive_brokers' as const;
  private client: IBClient | null = null;
  private keepalive: IBKeepalive | null = null;
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;

    const settings = await getSettings();
    const mode = settings.trading_mode || 'practice';

    const consumerKey = mode === 'live'
      ? settings.ib_live_consumer_key || ''
      : settings.ib_practice_consumer_key || '';
    const privateKey = mode === 'live'
      ? settings.ib_live_private_key || ''
      : settings.ib_practice_private_key || '';
    const accountId = mode === 'live'
      ? settings.ib_live_account_id || ''
      : settings.ib_practice_account_id || '';

    if (!consumerKey || !privateKey || !accountId) {
      throw new BrokerError(
        'IB credentials not configured. Set consumer key, private key, and account ID in settings.',
        'interactive_brokers',
        'MISSING_CREDENTIALS',
        false,
      );
    }

    const authManager = new IBAuthManager({
      consumerKey,
      privateKeyPem: privateKey,
    });

    const baseUrl = 'https://api.ibkr.com';

    this.client = new IBClient({ baseUrl, accountId, authManager });
    this.keepalive = new IBKeepalive(baseUrl, () => this.client!.getAuthHeaders());
    this.keepalive.start();
    this.connected = true;

    console.log(`[IB] Connected (mode: ${mode}, account: ${accountId})`);
  }

  async disconnect(): Promise<void> {
    this.keepalive?.stop();
    this.client = null;
    this.connected = false;
    console.log('[IB] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  private getClient(): IBClient {
    if (!this.client) throw new BrokerError('IB not connected', 'interactive_brokers', 'NOT_CONNECTED', false);
    return this.client;
  }

  private getIBInstrument(canonical: string): InstrumentConfig {
    const config = INSTRUMENTS[canonical];
    if (!config) throw new InstrumentNotSupportedError('interactive_brokers', canonical);
    return config;
  }

  // --- Account ---

  async getAccountSummary(): Promise<AccountSummary> {
    const client = this.getClient();
    const data = await client.getAccountSummary();

    // IB account summary uses field keys like 'totalcashvalue', 'netliquidation', etc.
    const getVal = (key: string): number => {
      const field = data[key];
      if (!field) return 0;
      return typeof field.amount === 'number' ? field.amount : parseFloat(field.value || '0');
    };

    return {
      balance: getVal('totalcashvalue'),
      nav: getVal('netliquidation'),
      marginAvailable: getVal('availablefunds'),
      unrealizedPL: getVal('unrealizedpnl'),
      currency: data['currency']?.value || 'USD',
      openTradeCount: 0, // Will be populated from positions
      marginUsed: getVal('initmarginreq'),
    };
  }

  // --- Pricing ---

  async getPricing(instrument: string): Promise<PriceQuote> {
    const client = this.getClient();
    const config = this.getIBInstrument(instrument);
    // Fields: 84=Bid, 86=Ask
    const snapshots = await client.getMarketDataSnapshot([config.ib.conid], ['84', '86']);
    const snap = snapshots[0];
    if (!snap) {
      throw new BrokerError(`No market data for ${instrument}`, 'interactive_brokers', 'NO_MARKET_DATA', true);
    }

    const bid = parseFloat(String(snap['84'] || '0'));
    const ask = parseFloat(String(snap['86'] || '0'));

    if (bid <= 0 || ask <= 0) {
      throw new BrokerError(`Invalid pricing for ${instrument}: bid=${bid}, ask=${ask}`, 'interactive_brokers', 'INVALID_PRICE', true);
    }

    return { instrument, ask, bid };
  }

  async getPricingMulti(instruments: string[]): Promise<PriceQuote[]> {
    const client = this.getClient();
    const configs = instruments.map((inst) => ({
      canonical: inst,
      config: this.getIBInstrument(inst),
    }));
    const conids = configs.map((c) => c.config.ib.conid);

    const snapshots = await client.getMarketDataSnapshot(conids, ['84', '86']);
    const snapMap = new Map(snapshots.map((s) => [s.conid, s]));

    return configs.map(({ canonical, config }) => {
      const snap = snapMap.get(config.ib.conid);
      const bid = snap ? parseFloat(String(snap['84'] || '0')) : 0;
      const ask = snap ? parseFloat(String(snap['86'] || '0')) : 0;
      return { instrument: canonical, ask, bid };
    });
  }

  // --- Trades ---

  async getOpenTrades(): Promise<BrokerTrade[]> {
    const client = this.getClient();
    const positions = await client.getPositions();
    return positions
      .filter((p) => p.position !== 0)
      .map((p) => this.positionToBrokerTrade(p));
  }

  async getTradeDetails(brokerTradeId: string): Promise<BrokerTrade> {
    // IB doesn't have a single "trade details" endpoint like Oanda.
    // We check positions first, then executions.
    const client = this.getClient();

    // Check if it's still an open position (brokerTradeId = conid for positions)
    const positions = await client.getPositions();
    const pos = positions.find((p) => String(p.conid) === brokerTradeId);
    if (pos && pos.position !== 0) {
      return this.positionToBrokerTrade(pos);
    }

    // Check executions for closed trade
    const executions = await client.getTrades();
    const exec = executions.find((e) => e.execution_id === brokerTradeId || String(e.conid) === brokerTradeId);
    if (exec) {
      return {
        brokerTradeId,
        instrument: this.conidToCanonical(exec.conid),
        units: exec.side === 'BUY' ? exec.size : -exec.size,
        entryPrice: parseFloat(exec.price),
        unrealizedPL: 0,
        state: 'CLOSED',
        realizedPL: exec.net_amount,
      };
    }

    // Position was flat — mark as closed
    return {
      brokerTradeId,
      instrument: '',
      units: 0,
      entryPrice: 0,
      unrealizedPL: 0,
      state: 'CLOSED',
    };
  }

  async getClosedTrades(count = 50): Promise<BrokerTrade[]> {
    const client = this.getClient();
    const executions = await client.getTrades();
    return executions.slice(0, count).map((exec) => ({
      brokerTradeId: exec.execution_id,
      instrument: this.conidToCanonical(exec.conid),
      units: exec.side === 'BUY' ? exec.size : -exec.size,
      entryPrice: parseFloat(exec.price),
      unrealizedPL: 0,
      state: 'CLOSED' as const,
      realizedPL: exec.net_amount,
      closeTime: exec.trade_time,
    }));
  }

  async getTransactionsSinceId(_id: string): Promise<TransactionRecord[]> {
    // IB Web API doesn't have a direct equivalent of Oanda's transaction stream.
    // Return executions as transaction records.
    const client = this.getClient();
    const executions = await client.getTrades();
    return executions.map((exec) => ({
      type: 'ORDER_FILL',
      brokerTradeId: exec.execution_id,
      reason: exec.order_description,
      price: parseFloat(exec.price),
      realizedPL: exec.net_amount,
      time: exec.trade_time,
    }));
  }

  // --- Order Execution ---

  async placeMarketOrder(
    instrument: string,
    units: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<OrderResult> {
    const client = this.getClient();
    const config = this.getIBInstrument(instrument);
    const side = units >= 0 ? 'BUY' : 'SELL';
    const quantity = Math.abs(units);

    // Build bracket order: parent market + TP limit + SL stop
    const parentOrder: IBOrderRequest = {
      conid: config.ib.conid,
      orderType: 'MKT',
      side,
      quantity,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `parent_${Date.now()}`,
    };

    const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
    const tpOrder: IBOrderRequest = {
      conid: config.ib.conid,
      orderType: 'LMT',
      side: tpSide,
      quantity,
      price: takeProfitPrice,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `tp_${Date.now()}`,
      parentId: parentOrder.cOID,
    };

    const slOrder: IBOrderRequest = {
      conid: config.ib.conid,
      orderType: 'STP',
      side: tpSide,
      quantity,
      auxPrice: stopLossPrice,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `sl_${Date.now()}`,
      parentId: parentOrder.cOID,
    };

    let response;
    try {
      response = await client.placeBracketOrder([parentOrder, tpOrder, slOrder]);
    } catch (e) {
      if (e instanceof BrokerError && e.message.includes('margin')) {
        throw new InsufficientMarginError('interactive_brokers', e);
      }
      throw e;
    }

    // IB may return a confirmation prompt that needs to be replied to.
    // Check for order_id in the response.
    const parentResponse = response[0];
    if (!parentResponse) {
      return { filled: false, rejectedReason: 'No response from IB order placement' };
    }

    // IB sometimes returns a message requiring confirmation
    if (parentResponse.message && parentResponse.id) {
      // Auto-confirm the order by replying
      try {
        const confirmResponse = await client.placeBracketOrder([parentOrder, tpOrder, slOrder]);
        if (confirmResponse[0]?.order_id) {
          return {
            filled: true,
            brokerTradeId: confirmResponse[0].order_id,
            fillPrice: undefined, // IB fills asynchronously — price comes later
          };
        }
      } catch {
        // Fall through to rejection
      }
    }

    if (parentResponse.order_id) {
      return {
        filled: true,
        brokerTradeId: parentResponse.order_id,
        fillPrice: undefined, // Will be populated by getTradeDetails later
      };
    }

    const reason = parentResponse.message?.join('; ') || parentResponse.order_status || 'Unknown error';
    if (reason.toLowerCase().includes('margin')) {
      throw new InsufficientMarginError('interactive_brokers');
    }

    throw new OrderRejectedError('interactive_brokers', reason);
  }

  async closeTrade(brokerTradeId: string): Promise<CloseResult> {
    const client = this.getClient();

    // Find the open position for this trade
    const positions = await client.getPositions();
    const pos = positions.find((p) => String(p.conid) === brokerTradeId);

    if (!pos || pos.position === 0) {
      // Position already flat
      return { fillPrice: undefined, realizedPL: undefined };
    }

    // Place a market order to close
    const closeSide = pos.position > 0 ? 'SELL' : 'BUY';
    const closeOrder: IBOrderRequest = {
      conid: pos.conid,
      orderType: 'MKT',
      side: closeSide,
      quantity: Math.abs(pos.position),
      tif: 'GTC',
      isClose: true,
    };

    const response = await client.placeOrder(closeOrder);
    const orderId = response[0]?.order_id;

    return {
      fillPrice: pos.mktPrice || undefined, // Approximate — actual fill comes asynchronously
      realizedPL: pos.realizedPnl || undefined,
    };
  }

  // --- Market Data ---

  async getCandles(
    instrument: string,
    from: string,
    to: string,
    granularity = 'M1',
  ): Promise<CandleData[]> {
    // IB Web API historical data is more complex — simplified implementation
    // For now, return empty. Can be enhanced with /iserver/marketdata/history endpoint.
    console.warn('[IB] getCandles not fully implemented — returning empty');
    return [];
  }

  // --- Private helpers ---

  private positionToBrokerTrade(pos: {
    conid: number;
    position: number;
    avgPrice: number;
    avgCost: number;
    mktPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    contractDesc: string;
    currency: string;
  }): BrokerTrade {
    return {
      brokerTradeId: String(pos.conid),
      instrument: this.conidToCanonical(pos.conid),
      units: pos.position,
      entryPrice: pos.avgPrice,
      unrealizedPL: pos.unrealizedPnl,
      state: pos.position !== 0 ? 'OPEN' : 'CLOSED',
      realizedPL: pos.realizedPnl,
    };
  }

  private conidToCanonical(conid: number): string {
    for (const [canonical, config] of Object.entries(INSTRUMENTS)) {
      if (config.ib.conid === conid) return canonical;
    }
    return `UNKNOWN_${conid}`;
  }
}
