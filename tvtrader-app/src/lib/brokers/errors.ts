/**
 * brokers/errors.ts
 *
 * Normalized error hierarchy for all broker integrations.
 * Each adapter catches broker-specific errors and wraps them in these classes.
 */

export class BrokerError extends Error {
  constructor(
    message: string,
    public readonly broker: string,
    public readonly code: string,
    public readonly isRetryable: boolean,
    public readonly originalError?: unknown,
  ) {
    super(`[${broker}] ${message}`);
    this.name = 'BrokerError';
  }
}

export class InsufficientMarginError extends BrokerError {
  constructor(broker: string, originalError?: unknown) {
    super('Insufficient margin to place order', broker, 'INSUFFICIENT_MARGIN', true, originalError);
    this.name = 'InsufficientMarginError';
  }
}

export class BrokerConnectionError extends BrokerError {
  constructor(broker: string, message: string, originalError?: unknown) {
    super(message, broker, 'CONNECTION_ERROR', true, originalError);
    this.name = 'BrokerConnectionError';
  }
}

export class BrokerAuthError extends BrokerError {
  constructor(broker: string, message: string, originalError?: unknown) {
    super(message, broker, 'AUTH_ERROR', false, originalError);
    this.name = 'BrokerAuthError';
  }
}

export class OrderRejectedError extends BrokerError {
  constructor(broker: string, reason: string, originalError?: unknown) {
    super(`Order rejected: ${reason}`, broker, 'ORDER_REJECTED', false, originalError);
    this.name = 'OrderRejectedError';
  }
}

export class InstrumentNotSupportedError extends BrokerError {
  constructor(broker: string, instrument: string) {
    super(`Instrument ${instrument} is not supported`, broker, 'INSTRUMENT_NOT_SUPPORTED', false);
    this.name = 'InstrumentNotSupportedError';
  }
}
