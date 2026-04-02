/**
 * interactive-brokers/keepalive.ts
 *
 * Manages the IB Web API session keepalive.
 * IB sessions time out after 5 minutes of inactivity.
 * This module calls /tickle every 4 minutes to maintain the session.
 */

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

export class IBKeepalive {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private baseUrl: string;
  private getAuthHeaders: () => Promise<Record<string, string>>;

  constructor(
    baseUrl: string,
    getAuthHeaders: () => Promise<Record<string, string>>,
  ) {
    this.baseUrl = baseUrl;
    this.getAuthHeaders = getAuthHeaders;
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      try {
        const headers = await this.getAuthHeaders();
        const res = await fetch(`${this.baseUrl}/v1/api/tickle`, {
          method: 'POST',
          headers,
        });
        if (!res.ok) {
          console.warn(`[IB-KEEPALIVE] Tickle failed (${res.status}) — session may have expired`);
        }
      } catch (e) {
        console.error('[IB-KEEPALIVE] Tickle error:', e);
      }
    }, KEEPALIVE_INTERVAL_MS);

    console.log('[IB-KEEPALIVE] Session keepalive started (every 4 min)');
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
