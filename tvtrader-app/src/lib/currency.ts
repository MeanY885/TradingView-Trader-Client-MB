import { getBroker } from './brokers/factory';

/**
 * Convert an amount in quoteCurrency to accountCurrency.
 * e.g. convertToAccountCurrency(5000, 'JPY', 'GBP') → ~£26
 */
export async function convertToAccountCurrency(
  amount: number,
  quoteCurrency: string,
  accountCurrency: string
): Promise<number> {
  if (quoteCurrency === accountCurrency) return amount;
  const broker = await getBroker();
  try {
    const p = await broker.getPricing(`${quoteCurrency}_${accountCurrency}`);
    const mid = (p.ask + p.bid) / 2;
    return amount * mid;
  } catch {
    try {
      const p = await broker.getPricing(`${accountCurrency}_${quoteCurrency}`);
      const mid = (p.ask + p.bid) / 2;
      return amount / mid;
    } catch {
      console.error(`Could not convert ${quoteCurrency} to ${accountCurrency}, using raw value`);
      return amount;
    }
  }
}

/**
 * Convert an amount in accountCurrency to quoteCurrency.
 * e.g. convertFromAccountCurrency(40, 'JPY', 'GBP') → ~7600
 */
export async function convertFromAccountCurrency(
  amountAccountCcy: number,
  quoteCurrency: string,
  accountCurrency: string
): Promise<number> {
  if (quoteCurrency === accountCurrency) return amountAccountCcy;
  const broker = await getBroker();
  try {
    const p = await broker.getPricing(`${accountCurrency}_${quoteCurrency}`);
    const mid = (p.ask + p.bid) / 2;
    return amountAccountCcy * mid;
  } catch {
    try {
      const p = await broker.getPricing(`${quoteCurrency}_${accountCurrency}`);
      const mid = (p.ask + p.bid) / 2;
      return amountAccountCcy / mid;
    } catch {
      console.error(`Could not convert ${accountCurrency} to ${quoteCurrency}, using raw value`);
      return amountAccountCcy;
    }
  }
}
