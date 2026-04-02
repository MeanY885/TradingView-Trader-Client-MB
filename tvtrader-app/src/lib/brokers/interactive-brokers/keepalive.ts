/**
 * interactive-brokers/keepalive.ts
 *
 * Keeps the IB Client Portal Gateway session alive by calling /tickle
 * every 55 seconds (session times out after ~5 minutes of inactivity).
 * No auth headers needed — the gateway uses session-based auth.
 */

import { ibGatewayFetch } from './gateway-fetch';

const KEEPALIVE_INTERVAL_MS = 55 * 1000; // 55 seconds

export class IBKeepalive {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      try {
        const res = await ibGatewayFetch(`${this.gatewayUrl}/v1/api/tickle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          console.warn(`[IB-KEEPALIVE] Tickle failed (${res.status}) — session may have expired`);
        }
      } catch (e) {
        console.error('[IB-KEEPALIVE] Tickle error:', e);
      }
    }, KEEPALIVE_INTERVAL_MS);

    console.log('[IB-KEEPALIVE] Session keepalive started (every 55s)');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[IB-KEEPALIVE] Session keepalive stopped');
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }
}
