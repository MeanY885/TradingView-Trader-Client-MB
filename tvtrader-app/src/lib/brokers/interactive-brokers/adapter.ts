/**
 * interactive-brokers/adapter.ts
 *
 * Implements BrokerAdapter for the IB Client Portal Gateway.
 * Translates between the normalized adapter interface and IB-specific API calls.
 *
 * Authentication is session-based — the user must log in via browser at the
 * gateway URL. No OAuth tokens or API keys required.
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
import { IBClient, IBOrderRequest, IBOrderResponse } from './client';
import { IBAuthManager } from './auth';
import { IBKeepalive } from './keepalive';
import { getSettings } from '../../db';

const DEFAULT_GATEWAY_URL = process.env.IB_GATEWAY_URL || 'http://localhost:5000';

export class IBAdapter implements BrokerAdapter {
  readonly brokerName = 'interactive_brokers' as const;
  private client: IBClient | null = null;
  private authManager: IBAuthManager | null = null;
  private keepalive: IBKeepalive | null = null;
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;

    const settings = await getSettings();

    const gatewayUrl = settings.ib_gateway_url || DEFAULT_GATEWAY_URL;
    const accountId = settings.ib_account_id || '';

    if (!accountId) {
      throw new BrokerError(
        'IB Account ID not configured. Set account ID in settings.',
        'interactive_brokers',
        'MISSING_CREDENTIALS',
        false,
      );
    }

    this.authManager = new IBAuthManager(gatewayUrl);
    this.client = new IBClient({ gatewayUrl, accountId });
    this.keepalive = new IBKeepalive(gatewayUrl);
    this.keepalive.start();
    this.connected = true;

    // Check if gateway is authenticated — log warning but don't fail.
    // The user may not have logged in yet. Auth errors will surface on actual API calls.
    try {
      await this.authManager.ensureAuthenticated();
      console.log(`[IB] Connected and authenticated via gateway at ${gatewayUrl} (account: ${accountId})`);
    } catch (e) {
      console.warn(`[IB] Connected to gateway at ${gatewayUrl} but NOT authenticated. User must log in via the gateway. Error: ${e}`);
    }
  }

  async disconnect(): Promise<void> {
    this.keepalive?.stop();
    this.client = null;
    this.authManager = null;
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
    const ledger = await client.getAccountLedger();

    // The ledger has entries keyed by currency. The "BASE" key has the totals.
    const base = ledger['BASE'] || Object.values(ledger)[0];
    if (!base) {
      return {
        balance: 0,
        nav: 0,
        marginAvailable: 0,
        unrealizedPL: 0,
        currency: 'USD',
        openTradeCount: 0,
        marginUsed: 0,
      };
    }

    return {
      balance: base.cashbalance || 0,
      nav: base.netliquidationvalue || 0,
      marginAvailable: base.funds || 0,
      unrealizedPL: base.unrealizedpnl || 0,
      currency: base.currency || 'USD',
      openTradeCount: 0, // Populated from positions
      marginUsed: 0,
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
      secType: config.ib.secType,
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
      secType: config.ib.secType,
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
      secType: config.ib.secType,
      orderType: 'STP',
      side: tpSide,
      quantity,
      auxPrice: stopLossPrice,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `sl_${Date.now()}`,
      parentId: parentOrder.cOID,
    };

    let response: IBOrderResponse[];
    try {
      response = await client.placeBracketOrder([parentOrder, tpOrder, slOrder]);
    } catch (e) {
      if (e instanceof BrokerError && e.message.includes('margin')) {
        throw new InsufficientMarginError('interactive_brokers', e);
      }
      throw e;
    }

    // Handle the IB confirmation flow — gateway may return a prompt requiring reply
    const result = await this.handleOrderResponse(client, response);
    return result;
  }

  /**
   * IB Gateway order responses may require confirmation via /iserver/reply/{replyId}.
   * This handles the full confirmation chain.
   */
  private async handleOrderResponse(
    client: IBClient,
    response: IBOrderResponse[],
  ): Promise<OrderResult> {
    if (!response.length) {
      return { filled: false, rejectedReason: 'No response from IB order placement' };
    }

    const first = response[0];

    // If we got an order_id, the order was accepted
    if (first.order_id) {
      return {
        filled: true,
        brokerTradeId: first.order_id,
        fillPrice: undefined, // IB fills asynchronously
      };
    }

    // If we got a confirmation prompt (id + message), reply to confirm
    if (first.id && first.message) {
      console.log(`[IB] Order requires confirmation: ${first.message.join('; ')}`);
      try {
        const confirmResponse = await client.confirmOrder(first.id);

        // Confirmation may chain — handle recursively (max 1 level deep)
        if (confirmResponse[0]?.order_id) {
          return {
            filled: true,
            brokerTradeId: confirmResponse[0].order_id,
            fillPrice: undefined,
          };
        }

        // Second confirmation needed (rare but possible)
        if (confirmResponse[0]?.id && confirmResponse[0]?.message) {
          const secondConfirm = await client.confirmOrder(confirmResponse[0].id);
          if (secondConfirm[0]?.order_id) {
            return {
              filled: true,
              brokerTradeId: secondConfirm[0].order_id,
              fillPrice: undefined,
            };
          }
        }
      } catch (e) {
        console.error('[IB] Order confirmation failed:', e);
      }
    }

    const reason = first.message?.join('; ') || first.order_status || 'Unknown error';
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

    // Handle confirmation if needed
    await this.handleOrderResponse(client, response);

    return {
      fillPrice: pos.mktPrice || undefined,
      realizedPL: pos.realizedPnl || undefined,
    };
  }

  // --- Market Data ---

  async getCandles(
    _instrument: string,
    _from: string,
    _to: string,
    _granularity = 'M1',
  ): Promise<CandleData[]> {
    // IB Gateway historical data can be enhanced with /iserver/marketdata/history
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
