/**
 * brokers/oanda/adapter.ts
 *
 * Wraps the existing oanda.ts functions behind the BrokerAdapter interface.
 * Normalizes all Oanda string-based responses into the typed adapter format.
 *
 * IMPORTANT: This adapter wraps the existing battle-tested oanda.ts without modifying it.
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
import { InsufficientMarginError, OrderRejectedError, BrokerError } from '../errors';

// Lazy-import the existing oanda module to avoid circular dependencies.
// These are resolved at call time, not import time.
let oandaModule: typeof import('../../oanda') | null = null;

async function getOanda() {
  if (!oandaModule) {
    oandaModule = await import('../../oanda');
  }
  return oandaModule;
}

export class OandaAdapter implements BrokerAdapter {
  readonly brokerName = 'oanda' as const;

  async connect(): Promise<void> {
    // REST — no persistent connection needed
  }

  async disconnect(): Promise<void> {
    // REST — nothing to close
  }

  isConnected(): boolean {
    return true; // REST is always "connected"
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const oanda = await getOanda();
    const data = await oanda.getAccountSummary();
    const acct = data.account;
    return {
      balance: parseFloat(acct.balance),
      nav: parseFloat(acct.NAV),
      marginAvailable: parseFloat(acct.marginAvailable),
      unrealizedPL: parseFloat(acct.unrealizedPL),
      currency: acct.currency,
      openTradeCount: acct.openTradeCount,
      marginUsed: parseFloat(acct.marginUsed),
    };
  }

  async getPricing(instrument: string): Promise<PriceQuote> {
    const oanda = await getOanda();
    const data = await oanda.getPricing(instrument);
    const p = data.prices[0];
    return {
      instrument: p.instrument,
      ask: parseFloat(p.asks[0].price),
      bid: parseFloat(p.bids[0].price),
    };
  }

  async getPricingMulti(instruments: string[]): Promise<PriceQuote[]> {
    const oanda = await getOanda();
    // Oanda supports comma-separated instruments in a single call
    const data = await oanda.getPricing(instruments.join(','));
    return data.prices.map((p) => ({
      instrument: p.instrument,
      ask: parseFloat(p.asks[0].price),
      bid: parseFloat(p.bids[0].price),
    }));
  }

  async getOpenTrades(): Promise<BrokerTrade[]> {
    const oanda = await getOanda();
    const data = await oanda.getOpenTrades();
    return data.trades.map((t) => this.mapToBrokerTrade(t));
  }

  async getTradeDetails(brokerTradeId: string): Promise<BrokerTrade> {
    const oanda = await getOanda();
    const data = await oanda.getTradeDetails(brokerTradeId);
    return this.mapTradeDetailsToBrokerTrade(brokerTradeId, data.trade);
  }

  async getClosedTrades(count = 50): Promise<BrokerTrade[]> {
    const oanda = await getOanda();
    const data = await oanda.getClosedTrades(count);
    return data.trades.map((t) => this.mapClosedToBrokerTrade(t));
  }

  async getTransactionsSinceId(id: string): Promise<TransactionRecord[]> {
    const oanda = await getOanda();
    const data = await oanda.getTransactionsSinceId(id);
    return data.transactions.map((t) => ({
      type: t.type,
      brokerTradeId: t.tradeID,
      tradesClosed: t.tradesClosed?.map((tc) => ({
        brokerTradeId: tc.tradeID,
        price: tc.price ? parseFloat(tc.price) : undefined,
        realizedPL: tc.realizedPL ? parseFloat(tc.realizedPL) : undefined,
      })),
      reason: t.reason,
      price: t.price ? parseFloat(t.price) : undefined,
      realizedPL: t.pl ? parseFloat(t.pl) : undefined,
      time: t.time,
    }));
  }

  async placeMarketOrder(
    instrument: string,
    units: number,
    takeProfitPrice: number,
    stopLossPrice: number,
  ): Promise<OrderResult> {
    const oanda = await getOanda();
    const { getInstrumentPrecision } = await import('../instruments');
    const precision = getInstrumentPrecision(instrument);
    const tpFormatted = takeProfitPrice.toFixed(precision);
    const slFormatted = stopLossPrice.toFixed(precision);
    const unitsStr = units.toString();

    let result;
    try {
      result = await oanda.placeMarketOrder(instrument, unitsStr, tpFormatted, slFormatted);
    } catch (e) {
      throw new BrokerError(
        e instanceof Error ? e.message : String(e),
        'oanda',
        'API_ERROR',
        true,
        e,
      );
    }

    if (result.orderCancelTransaction) {
      const reason = result.orderCancelTransaction.reason;
      if (reason === 'INSUFFICIENT_MARGIN') {
        throw new InsufficientMarginError('oanda');
      }
      throw new OrderRejectedError('oanda', reason);
    }

    const fill = result.orderFillTransaction;
    if (!fill?.tradeOpened) {
      return { filled: false, rejectedReason: 'No fill transaction' };
    }

    return {
      filled: true,
      brokerTradeId: fill.tradeOpened.tradeID,
      fillPrice: parseFloat(fill.tradeOpened.price),
      realizedPL: fill.pl ? parseFloat(fill.pl) : undefined,
    };
  }

  async closeTrade(brokerTradeId: string): Promise<CloseResult> {
    const oanda = await getOanda();
    const result = await oanda.closeTrade(brokerTradeId);
    return {
      fillPrice: result.orderFillTransaction?.price
        ? parseFloat(result.orderFillTransaction.price)
        : undefined,
      realizedPL: result.orderFillTransaction?.pl
        ? parseFloat(result.orderFillTransaction.pl)
        : undefined,
    };
  }

  async getCandles(
    instrument: string,
    from: string,
    to: string,
    granularity = 'M1',
  ): Promise<CandleData[]> {
    const oanda = await getOanda();
    const data = await oanda.getCandles(instrument, from, to, granularity);
    return data.candles.map((c) => ({
      time: c.time,
      midHigh: parseFloat(c.mid.h),
      midLow: parseFloat(c.mid.l),
    }));
  }

  // --- Private mapping helpers ---

  private mapToBrokerTrade(t: Record<string, unknown>): BrokerTrade {
    const units = parseFloat(String(t.currentUnits ?? t.initialUnits ?? '0'));
    const tpOrder = t.takeProfitOrder as Record<string, string> | undefined;
    const slOrder = t.stopLossOrder as Record<string, string> | undefined;
    return {
      brokerTradeId: String(t.id),
      instrument: String(t.instrument),
      units,
      entryPrice: parseFloat(String(t.price ?? '0')),
      unrealizedPL: parseFloat(String(t.unrealizedPL ?? '0')),
      state: 'OPEN',
      takeProfitPrice: tpOrder?.price ? parseFloat(tpOrder.price) : undefined,
      stopLossPrice: slOrder?.price ? parseFloat(slOrder.price) : undefined,
      initialMarginRequired: t.initialMarginRequired ? parseFloat(String(t.initialMarginRequired)) : undefined,
    };
  }

  private mapTradeDetailsToBrokerTrade(
    brokerTradeId: string,
    t: {
      id: string;
      state: string;
      unrealizedPL: string;
      averageClosePrice?: string;
      realizedPL?: string;
      closeTime?: string;
      highestPrice?: string;
      lowestPrice?: string;
      takeProfitOrder?: { state: string };
      stopLossOrder?: { state: string };
    },
  ): BrokerTrade {
    return {
      brokerTradeId,
      instrument: '', // Not returned by getTradeDetails — caller already knows
      units: 0, // Not returned by getTradeDetails — caller already knows
      entryPrice: 0, // Not returned by getTradeDetails — caller already knows
      unrealizedPL: parseFloat(t.unrealizedPL || '0'),
      state: t.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      averageClosePrice: t.averageClosePrice ? parseFloat(t.averageClosePrice) : undefined,
      realizedPL: t.realizedPL ? parseFloat(t.realizedPL) : undefined,
      closeTime: t.closeTime,
      highestPrice: t.highestPrice ? parseFloat(t.highestPrice) : undefined,
      lowestPrice: t.lowestPrice ? parseFloat(t.lowestPrice) : undefined,
      takeProfitFilled: t.takeProfitOrder?.state === 'FILLED',
      stopLossFilled: t.stopLossOrder?.state === 'FILLED',
      takeProfitPrice: undefined, // state only, not price
      stopLossPrice: undefined,
    };
  }

  private mapClosedToBrokerTrade(t: {
    id: string;
    averageClosePrice?: string;
    realizedPL?: string;
    closeTime?: string;
    highestPrice?: string;
    lowestPrice?: string;
    takeProfitOrder?: { state: string };
    stopLossOrder?: { state: string };
  }): BrokerTrade {
    return {
      brokerTradeId: t.id,
      instrument: '',
      units: 0,
      entryPrice: 0,
      unrealizedPL: 0,
      state: 'CLOSED',
      averageClosePrice: t.averageClosePrice ? parseFloat(t.averageClosePrice) : undefined,
      realizedPL: t.realizedPL ? parseFloat(t.realizedPL) : undefined,
      closeTime: t.closeTime,
      highestPrice: t.highestPrice ? parseFloat(t.highestPrice) : undefined,
      lowestPrice: t.lowestPrice ? parseFloat(t.lowestPrice) : undefined,
      takeProfitFilled: t.takeProfitOrder?.state === 'FILLED',
      stopLossFilled: t.stopLossOrder?.state === 'FILLED',
    };
  }
}
