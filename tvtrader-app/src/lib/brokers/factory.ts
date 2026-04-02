/**
 * brokers/factory.ts
 *
 * Provides getBroker() — the single entry point for all broker operations.
 * Reads the active broker from settings and returns a cached adapter instance.
 */

import { getSettings } from '../db';
import { BrokerAdapter, BrokerType } from './types';
import { OandaAdapter } from './oanda/adapter';
import { IBAdapter } from './interactive-brokers/adapter';

let cachedAdapter: BrokerAdapter | null = null;
let cachedBrokerType: BrokerType | null = null;

/**
 * Returns the active broker adapter. Caches the instance and reuses it
 * unless the broker setting has changed.
 */
export async function getBroker(): Promise<BrokerAdapter> {
  const settings = await getSettings();
  const brokerType = (settings.broker || 'oanda') as BrokerType;

  if (cachedAdapter && cachedBrokerType === brokerType) {
    return cachedAdapter;
  }

  // Disconnect previous adapter if switching brokers
  if (cachedAdapter) {
    await cachedAdapter.disconnect().catch((e) =>
      console.error(`[BROKER] Error disconnecting ${cachedBrokerType}:`, e),
    );
  }

  const adapter = createAdapter(brokerType);
  await adapter.connect();

  cachedAdapter = adapter;
  cachedBrokerType = brokerType;
  return adapter;
}

function createAdapter(type: BrokerType): BrokerAdapter {
  switch (type) {
    case 'oanda':
      return new OandaAdapter();
    case 'interactive_brokers':
      return new IBAdapter();
    default:
      throw new Error(`Unknown broker type: ${type}`);
  }
}

/**
 * Force-clears the cached adapter. Useful for testing or when settings change.
 */
export async function resetBrokerCache(): Promise<void> {
  if (cachedAdapter) {
    await cachedAdapter.disconnect().catch(() => {});
  }
  cachedAdapter = null;
  cachedBrokerType = null;
}
