/**
 * brokers/instruments.ts
 *
 * Centralized instrument registry. Maps canonical instrument names (BASE_QUOTE)
 * to broker-specific identifiers, pip sizes, and display precision.
 *
 * NOTE: IB contract IDs (conid) must be verified against the live IB API before deployment.
 */

export interface IBContractSpec {
  conid: number;
  symbol: string;
  exchange: string;
  currency: string;
  secType: string; // CASH, CMDTY, etc.
}

export interface InstrumentConfig {
  canonical: string;      // e.g. 'EUR_USD'
  displayName: string;    // e.g. 'EUR/USD'
  pipSize: number;
  precision: number;      // decimal places for price formatting
  oanda: string;          // Oanda symbol
  ib: IBContractSpec;     // Interactive Brokers contract spec
}

/**
 * All supported instruments. Add new instruments here.
 * Both adapters use this as the single source of truth.
 */
export const INSTRUMENTS: Record<string, InstrumentConfig> = {
  EUR_USD: {
    canonical: 'EUR_USD',
    displayName: 'EUR/USD',
    pipSize: 0.0001,
    precision: 5,
    oanda: 'EUR_USD',
    ib: { conid: 143916318, symbol: 'EUR', exchange: 'SMART', currency: 'USD', secType: 'CFD' },
  },
  XAU_USD: {
    canonical: 'XAU_USD',
    displayName: 'XAU/USD',
    pipSize: 1.0,
    precision: 2,
    oanda: 'XAU_USD',
    ib: { conid: 69067924, symbol: 'XAUUSD', exchange: 'SMART', currency: 'USD', secType: 'CMDTY' },
  },
  NZD_JPY: {
    canonical: 'NZD_JPY',
    displayName: 'NZD/JPY',
    pipSize: 0.01,
    precision: 3,
    oanda: 'NZD_JPY',
    ib: { conid: 230949943, symbol: 'NZD', exchange: 'SMART', currency: 'JPY', secType: 'CFD' },
  },
};

export function getInstrumentConfig(canonical: string): InstrumentConfig | undefined {
  return INSTRUMENTS[canonical];
}

export function getPipSize(instrument: string): number {
  return INSTRUMENTS[instrument]?.pipSize ?? 0.0001;
}

export function getInstrumentPrecision(instrument: string): number {
  return INSTRUMENTS[instrument]?.precision ?? 5;
}

export function formatPrice(price: number, instrument: string): string {
  return price.toFixed(getInstrumentPrecision(instrument));
}

export function calcPips(a: number, b: number, instrument: string): number {
  return (a - b) / getPipSize(instrument);
}

export function getSupportedInstruments(): string[] {
  return Object.keys(INSTRUMENTS);
}
