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
  /** Conids that have been primed (first snapshot call subscribes to data) */
  private primedConids = new Set<number>();

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
      // Suppress common order warnings that block bracket order placement
      await this.client.suppressOrderWarnings();
      console.log(`[IB] Order warnings suppressed`);
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
    const [ledger, positions] = await Promise.all([
      client.getAccountLedger(),
      client.getPositions().catch(() => []),
    ]);

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

    const nav = base.netliquidationvalue || 0;
    const marginAvailable = base.funds || 0;
    const openTradeCount = positions.filter((p) => p.position !== 0).length;
    // marginUsed = NAV - available margin (mirrors Oanda's calculation)
    const marginUsed = Math.max(0, nav - marginAvailable);

    return {
      balance: base.cashbalance || 0,
      nav,
      marginAvailable,
      unrealizedPL: base.unrealizedpnl || 0,
      currency: base.currency || 'USD',
      openTradeCount,
      marginUsed,
    };
  }

  // --- Pricing ---

  private parseSnapshot(instrument: string, snap: Record<string, unknown>): PriceQuote | null {
    const bid = parseFloat(String(snap['84'] || '0'));
    const ask = parseFloat(String(snap['86'] || '0'));
    if (bid > 0 && ask > 0) {
      return { instrument, ask, bid };
    }
    // Fall back to Last Price if bid/ask aren't available
    const last = parseFloat(String(snap['31'] || '0'));
    if (last > 0) {
      const spreadFactor = instrument === 'XAU_USD' ? 0.0003 : 0.00005;
      const halfSpread = last * spreadFactor;
      return { instrument, ask: last + halfSpread, bid: last - halfSpread };
    }
    return null;
  }

  async getPricing(instrument: string): Promise<PriceQuote> {
    const config = INSTRUMENTS[instrument];
    if (!config) {
      throw new BrokerError(`Unknown instrument ${instrument}`, 'interactive_brokers', 'INVALID_PRICE', true);
    }

    const client = this.getClient();
    const conid = config.ib.conid;
    const needsPriming = !this.primedConids.has(conid);

    // Fields: 31=Last, 84=Bid, 86=Ask
    // IB's snapshot API requires priming — the first call subscribes to the data
    // and often returns zeros. On first call, retry a few times. After that, single call.
    const maxAttempts = needsPriming ? 5 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const snapshots = await client.getMarketDataSnapshot([conid], ['31', '84', '86']);
        const snap = snapshots[0];
        if (snap) {
          console.log(`[IB] Snapshot for ${instrument} (attempt ${attempt + 1}/${maxAttempts}):`, JSON.stringify(snap));
          const quote = this.parseSnapshot(instrument, snap);
          if (quote) {
            this.primedConids.add(conid);
            return quote;
          }
        } else {
          console.warn(`[IB] No snapshot returned for ${instrument} (attempt ${attempt + 1}/${maxAttempts}), raw:`, JSON.stringify(snapshots));
        }
      } catch (e) {
        console.error(`[IB] Snapshot error for ${instrument} (attempt ${attempt + 1}/${maxAttempts}):`, e);
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Fallback: use mktPrice from the open position for this conid
    try {
      const positions = await client.getPositions();
      console.log(`[IB] Positions fallback for ${instrument} — found ${positions.length} positions:`, JSON.stringify(positions.map(p => ({ conid: p.conid, mktPrice: p.mktPrice, position: p.position }))));
      const pos = positions.find((p) => p.conid === conid);
      if (pos && pos.mktPrice > 0) {
        const price = pos.mktPrice;
        const spreadFactor = instrument === 'XAU_USD' ? 0.0003 : 0.00005;
        const halfSpread = price * spreadFactor;
        console.log(`[IB] Using position mktPrice for ${instrument}: ${price.toFixed(5)}`);
        return { instrument, ask: price + halfSpread, bid: price - halfSpread };
      }
    } catch (e) {
      console.warn(`[IB] Position fallback failed for ${instrument}:`, e);
    }

    throw new BrokerError(`No pricing available for ${instrument} from IB`, 'interactive_brokers', 'INVALID_PRICE', true);
  }

  async getPricingMulti(instruments: string[]): Promise<PriceQuote[]> {
    const client = this.getClient();
    const registered = instruments.filter((inst) => INSTRUMENTS[inst]);

    const results = new Map<string, PriceQuote>();

    if (registered.length > 0) {
      const configs = registered.map((inst) => ({
        canonical: inst,
        config: this.getIBInstrument(inst),
      }));
      const conids = configs.map((c) => c.config.ib.conid);
      const snapshots = await client.getMarketDataSnapshot(conids, ['31', '84', '86']);
      const snapMap = new Map(snapshots.map((s) => [s.conid, s]));

      for (const { canonical, config } of configs) {
        const snap = snapMap.get(config.ib.conid);
        if (!snap) continue;
        const bid = parseFloat(String(snap['84'] || '0'));
        const ask = parseFloat(String(snap['86'] || '0'));
        if (bid > 0 && ask > 0) {
          results.set(canonical, { instrument: canonical, ask, bid });
          continue;
        }
        const last = parseFloat(String(snap['31'] || '0'));
        if (last > 0) {
          const spreadFactor = canonical === 'XAU_USD' ? 0.0003 : 0.00005;
          const halfSpread = last * spreadFactor;
          results.set(canonical, { instrument: canonical, ask: last + halfSpread, bid: last - halfSpread });
        }
      }
    }

    // Fallback: use position mktPrice for any missing instruments
    const missing = instruments.filter((inst) => !results.has(inst));
    if (missing.length > 0) {
      try {
        const positions = await client.getPositions();
        for (const inst of missing) {
          const config = INSTRUMENTS[inst];
          if (!config) continue;
          const pos = positions.find((p) => p.conid === config.ib.conid);
          if (pos && pos.mktPrice > 0) {
            const spreadFactor = inst === 'XAU_USD' ? 0.0003 : 0.00005;
            const halfSpread = pos.mktPrice * spreadFactor;
            results.set(inst, { instrument: inst, ask: pos.mktPrice + halfSpread, bid: pos.mktPrice - halfSpread });
          }
        }
      } catch (e) {
        console.warn('[IB] Position fallback in getPricingMulti failed:', e);
      }
    }

    return instruments.map((inst) =>
      results.get(inst) || { instrument: inst, ask: 0, bid: 0 }
    );
  }

  // --- Trades ---

  /**
   * Fetch open orders and build a map of conid → { takeProfitPrice, stopLossPrice }.
   * This gives IB the same TP/SL visibility that Oanda provides natively on trades.
   */
  private async getBracketOrderMap(client: IBClient): Promise<Map<number, { takeProfitPrice?: number; stopLossPrice?: number }>> {
    const map = new Map<number, { takeProfitPrice?: number; stopLossPrice?: number }>();
    try {
      const openOrders = await client.getOpenOrders();
      for (const order of openOrders) {
        if (!map.has(order.conid)) map.set(order.conid, {});
        const entry = map.get(order.conid)!;
        // IB returns origOrderType as "LIMIT"/"STOP" (not "LMT"/"STP")
        // For LIMIT orders, price is in the `price` field
        // For STOP orders, price is in `auxPrice` or `stop_price` (price is empty)
        if (order.origOrderType === 'LIMIT' && order.price > 0) {
          entry.takeProfitPrice = order.price;
        } else if (order.origOrderType === 'STOP') {
          const stopPrice = order.auxPrice || order.stop_price || 0;
          if (stopPrice > 0) entry.stopLossPrice = stopPrice;
        }
      }
    } catch (e) {
      console.warn('[IB] Failed to fetch open orders for bracket map:', e);
    }
    return map;
  }

  async getOpenTrades(): Promise<BrokerTrade[]> {
    const client = this.getClient();
    const [positions, bracketMap] = await Promise.all([
      client.getPositions(),
      this.getBracketOrderMap(client),
    ]);
    return positions
      .filter((p) => p.position !== 0)
      .map((p) => {
        const trade = this.positionToBrokerTrade(p);
        const bracket = bracketMap.get(p.conid);
        if (bracket) {
          trade.takeProfitPrice = bracket.takeProfitPrice;
          trade.stopLossPrice = bracket.stopLossPrice;
        }
        return trade;
      });
  }

  async getTradeDetails(brokerTradeId: string): Promise<BrokerTrade> {
    const client = this.getClient();

    // Check if it's still an open position (brokerTradeId = conid for positions)
    const positions = await client.getPositions();
    const pos = positions.find((p) => String(p.conid) === brokerTradeId);
    if (pos && pos.position !== 0) {
      const trade = this.positionToBrokerTrade(pos);
      // IB's position unrealizedPnl is cached and stale — compute from live pricing
      // and convert to account currency so the rest of the app gets real-time P/L
      // in the same format Oanda provides natively.
      const instrument = this.conidToCanonical(pos.conid);
      if (instrument) {
        try {
          const pricing = await this.getPricing(instrument);
          const mid = (pricing.ask + pricing.bid) / 2;
          const rawPL = (mid - pos.avgPrice) * pos.position;
          // Convert from quote currency to account currency
          const { convertToAccountCurrency } = await import('../../currency');
          const settings = await getSettings();
          const quoteCcy = instrument.split('_')[1];
          const acctCcy = settings.account_currency || 'GBP';
          trade.unrealizedPL = await convertToAccountCurrency(rawPL, quoteCcy, acctCcy);
        } catch { /* keep IB's cached value as fallback */ }
      }
      return trade;
    }

    // Check executions for closed trade
    const [executions, orderTypeMap] = await Promise.all([
      client.getTrades(),
      this.getOrderTypeMap(client),
    ]);
    const exec = executions.find((e) => e.execution_id === brokerTradeId || String(e.conid) === brokerTradeId);
    if (exec) {
      const orderType = orderTypeMap.get(exec.order_id);
      return {
        brokerTradeId,
        instrument: this.conidToCanonical(exec.conid),
        units: exec.side === 'B' ? exec.size : -exec.size,
        entryPrice: parseFloat(exec.price),
        unrealizedPL: 0,
        state: 'CLOSED',
        realizedPL: exec.net_amount,
        averageClosePrice: parseFloat(exec.price),
        closeTime: exec.trade_time,
        takeProfitFilled: orderType === 'LIMIT',
        stopLossFilled: orderType === 'STOP',
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
    const [executions, orderTypeMap] = await Promise.all([
      client.getTrades(),
      this.getOrderTypeMap(client),
    ]);
    return executions.slice(0, count).map((exec) => {
      const orderType = orderTypeMap.get(exec.order_id);
      const isTP = orderType === 'LIMIT';
      const isSL = orderType === 'STOP';
      return {
        // Use conid as brokerTradeId — consistent with placeMarketOrder which
        // stores conid as the trade identifier. execution_id is IB-internal.
        brokerTradeId: String(exec.conid),
        instrument: this.conidToCanonical(exec.conid),
        units: exec.side === 'B' ? exec.size : -exec.size,
        entryPrice: parseFloat(exec.price),
        unrealizedPL: 0,
        state: 'CLOSED' as const,
        realizedPL: exec.net_amount,
        closeTime: exec.trade_time,
        averageClosePrice: parseFloat(exec.price),
        takeProfitFilled: isTP,
        stopLossFilled: isSL,
      };
    });
  }

  async getTransactionsSinceId(_id: string): Promise<TransactionRecord[]> {
    const client = this.getClient();
    const [executions, orderTypeMap] = await Promise.all([
      client.getTrades(),
      this.getOrderTypeMap(client),
    ]);
    return executions.map((exec) => {
      const orderType = orderTypeMap.get(exec.order_id);
      const reason = orderType === 'LIMIT' ? 'TAKE_PROFIT_ORDER'
        : orderType === 'STOP' ? 'STOP_LOSS_ORDER'
        : exec.order_description;
      return {
        type: 'ORDER_FILL',
        brokerTradeId: String(exec.conid),
        tradesClosed: [{
          brokerTradeId: String(exec.conid),
          price: parseFloat(exec.price),
          realizedPL: exec.net_amount,
        }],
        reason,
        price: parseFloat(exec.price),
        realizedPL: exec.net_amount,
        time: exec.trade_time,
      };
    });
  }

  /**
   * Build a map of orderId → origOrderType from the orders endpoint.
   * Used to classify executions as TP (LIMIT) or SL (STOP) fills,
   * since the trades endpoint doesn't include order type info.
   */
  private async getOrderTypeMap(client: IBClient): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const openOrders = await client.getOpenOrders();
      for (const order of openOrders) {
        map.set(order.orderId, order.origOrderType);
      }
    } catch (e) {
      console.warn('[IB] Failed to fetch orders for type classification:', e);
    }
    return map;
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
    const conid = config.ib.conid;
    // IB order API requires secType as "conid:TYPE" format
    const secTypeStr = `${conid}:${config.ib.secType}`;

    // Build bracket order: parent market + TP limit + SL stop
    const parentCOID = `parent_${Date.now()}`;
    const parentOrder: IBOrderRequest = {
      conid,
      secType: secTypeStr,
      orderType: 'MKT',
      side,
      quantity,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: parentCOID,
    };

    const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
    const tpOrder: IBOrderRequest = {
      conid,
      secType: secTypeStr,
      orderType: 'LMT',
      side: tpSide,
      quantity,
      price: takeProfitPrice,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `tp_${Date.now()}`,
      parentId: parentCOID,
    };

    const slOrder: IBOrderRequest = {
      conid,
      secType: secTypeStr,
      orderType: 'STP',
      side: tpSide,
      quantity,
      price: stopLossPrice,
      tif: 'GTC',
      listingExchange: config.ib.exchange,
      cOID: `sl_${Date.now()}`,
      parentId: parentCOID,
    };

    let response: IBOrderResponse[];
    try {
      console.log(`[IB] Bracket order payload:`, JSON.stringify({ orders: [parentOrder, tpOrder, slOrder] }));
      response = await client.placeBracketOrder([parentOrder, tpOrder, slOrder]);
      console.log(`[IB] Bracket order response:`, JSON.stringify(response));
    } catch (e) {
      console.error(`[IB] Bracket order failed:`, e);
      if (e instanceof BrokerError && e.message.includes('margin')) {
        throw new InsufficientMarginError('interactive_brokers', e);
      }
      throw e;
    }

    // Handle the IB confirmation flow — gateway may return a prompt requiring reply
    await this.handleOrderConfirmations(client, response);

    // Use conid as brokerTradeId — all position lookups use conid
    // Poll briefly for fill confirmation
    let fillPrice: number | undefined;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const positions = await client.getPositions();
      const pos = positions.find((p) => p.conid === conid && p.position !== 0);
      if (pos) {
        fillPrice = pos.avgPrice;
        console.log(`[IB] Position confirmed for ${instrument}: ${pos.position} @ ${pos.avgPrice}`);
        break;
      }
    }

    return {
      filled: true,
      brokerTradeId: String(conid),
      fillPrice,
    };
  }

  /**
   * IB Gateway order responses may require confirmation via /iserver/reply/{replyId}.
   * Handles the full confirmation chain (up to 3 levels deep).
   */
  private async handleOrderConfirmations(
    client: IBClient,
    response: IBOrderResponse[],
  ): Promise<void> {
    if (!response.length) return;

    for (const item of response) {
      // If it's a confirmation prompt, reply to confirm
      if (item.id && item.message) {
        console.log(`[IB] Order requires confirmation: ${item.message.join('; ')}`);
        try {
          const confirmResponse = await client.confirmOrder(item.id);
          console.log(`[IB] Confirmation response:`, JSON.stringify(confirmResponse));
          // Handle chained confirmations
          await this.handleOrderConfirmations(client, confirmResponse);
        } catch (e) {
          console.error('[IB] Order confirmation failed:', e);
        }
      }

      // Check for rejection
      if (item.order_status && item.order_status.toLowerCase().includes('reject')) {
        const reason = item.message?.join('; ') || item.order_status;
        if (reason.toLowerCase().includes('margin')) {
          throw new InsufficientMarginError('interactive_brokers');
        }
        throw new OrderRejectedError('interactive_brokers', reason);
      }
    }
  }

  async closeTrade(brokerTradeId: string): Promise<CloseResult> {
    const client = this.getClient();

    // Cancel any existing bracket orders (TP/SL) for this conid FIRST
    // to prevent orphaned orders firing after the position is closed.
    await this.cancelBracketOrdersForConid(client, parseInt(brokerTradeId, 10));

    // Find the open position for this trade
    const positions = await client.getPositions();
    const pos = positions.find((p) => String(p.conid) === brokerTradeId);

    if (!pos || pos.position === 0) {
      return { fillPrice: undefined, realizedPL: undefined };
    }

    // Place a market order to close
    const closeSide = pos.position > 0 ? 'SELL' : 'BUY';
    const config = Object.values(INSTRUMENTS).find((c) => c.ib.conid === pos.conid);
    const closeOrder: IBOrderRequest = {
      conid: pos.conid,
      secType: config ? `${pos.conid}:${config.ib.secType}` : undefined,
      orderType: 'MKT',
      side: closeSide,
      quantity: Math.abs(pos.position),
      tif: 'GTC',
      isClose: true,
    };

    const response = await client.placeOrder(closeOrder);

    // Handle confirmation if needed
    await this.handleOrderConfirmations(client, response);

    return {
      fillPrice: pos.mktPrice || undefined,
      realizedPL: pos.realizedPnl || undefined,
    };
  }

  /**
   * Cancel all open bracket orders (TP limit + SL stop) for a given conid.
   * Oanda does this automatically when a trade is closed; IB does not.
   */
  private async cancelBracketOrdersForConid(client: IBClient, conid: number): Promise<void> {
    try {
      const openOrders = await client.getOpenOrders();
      const bracketOrders = openOrders.filter(
        (o) => o.conid === conid && (o.origOrderType === 'LIMIT' || o.origOrderType === 'STOP')
      );
      for (const order of bracketOrders) {
        try {
          await client.cancelOrder(String(order.orderId));
          console.log(`[IB] Cancelled bracket order ${order.orderId} (${order.origOrderType}) for conid ${conid}`);
        } catch (e) {
          console.warn(`[IB] Failed to cancel bracket order ${order.orderId}:`, e);
        }
      }
    } catch (e) {
      console.warn(`[IB] Failed to fetch open orders for bracket cancellation:`, e);
    }
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
