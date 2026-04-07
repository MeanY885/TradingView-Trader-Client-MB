/**
 * interactive-brokers/keepalive.ts
 *
 * Keeps the IB Client Portal Gateway session alive and monitors authentication.
 *
 * Two loops run concurrently:
 * 1. Tickle loop (every 55s) — prevents idle timeout by calling /tickle.
 *    Parses the response for session/ssoExpires status.
 * 2. Auth-check loop (every 3 min) — calls /iserver/auth/status and, when
 *    the session is not authenticated, attempts automatic recovery:
 *      a. /sso/validate
 *      b. /iserver/reauthenticate
 *      c. /portfolio/accounts  (required after re-auth to init brokerage session)
 *
 * If automatic recovery fails the session truly needs a browser re-login.
 */

import { ibGatewayFetch } from './gateway-fetch';

const TICKLE_INTERVAL_MS = 55_000;       // 55 seconds
const AUTH_CHECK_INTERVAL_MS = 3 * 60_000; // 3 minutes
const RECOVERY_PAUSE_MS = 3_000;          // pause between recovery steps

interface TickleResponse {
  session?: string;       // e.g. "1a2b3c..."
  ssoExpires?: number;    // ms until SSO token expires
  collission?: boolean;   // competing session
  isFT?: boolean;         // is paper/financial-advisor account
  isPending?: boolean;    // login pending
}

export class IBKeepalive {
  private tickleTimer: ReturnType<typeof setInterval> | null = null;
  private authCheckTimer: ReturnType<typeof setInterval> | null = null;
  private gatewayUrl: string;
  /** Tracks consecutive auth failures so we can back off logging */
  private consecutiveAuthFailures = 0;
  /** Whether accounts endpoint has been called after the last successful auth */
  private accountsInitialized = false;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  start(): void {
    if (this.tickleTimer) return; // already running

    // --- Tickle loop ---
    this.tickleTimer = setInterval(() => this.doTickle(), TICKLE_INTERVAL_MS);

    // --- Auth-check loop ---
    this.authCheckTimer = setInterval(() => this.doAuthCheck(), AUTH_CHECK_INTERVAL_MS);

    // Run an immediate auth check on start
    this.doAuthCheck();

    console.log('[IB-KEEPALIVE] Started — tickle every 55s, auth-check every 3min');
  }

  stop(): void {
    if (this.tickleTimer) { clearInterval(this.tickleTimer); this.tickleTimer = null; }
    if (this.authCheckTimer) { clearInterval(this.authCheckTimer); this.authCheckTimer = null; }
    this.accountsInitialized = false;
    console.log('[IB-KEEPALIVE] Stopped');
  }

  isRunning(): boolean {
    return this.tickleTimer !== null;
  }

  // ------------------------------------------------------------------ tickle

  private async doTickle(): Promise<void> {
    try {
      const res = await ibGatewayFetch(`${this.gatewayUrl}/v1/api/tickle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[IB-KEEPALIVE] Tickle failed (${res.status})`);
        return;
      }

      const data: TickleResponse = await res.json().catch(() => ({}));

      // If SSO is expiring soon (< 10 min), proactively revalidate
      if (data.ssoExpires !== undefined && data.ssoExpires < 10 * 60_000) {
        console.warn(`[IB-KEEPALIVE] SSO expiring in ${Math.round(data.ssoExpires / 1000)}s — triggering proactive revalidation`);
        await this.attemptRecovery();
      }
    } catch (e) {
      console.error('[IB-KEEPALIVE] Tickle error:', e);
    }
  }

  // -------------------------------------------------------------- auth check

  private async doAuthCheck(): Promise<void> {
    try {
      const status = await this.getAuthStatus();

      if (status.authenticated && status.connected) {
        if (this.consecutiveAuthFailures > 0) {
          console.log('[IB-KEEPALIVE] Session recovered — authenticated and connected');
        }
        this.consecutiveAuthFailures = 0;

        // Ensure accounts are initialized after (re)authentication
        if (!this.accountsInitialized) {
          await this.initializeAccounts();
        }
        return;
      }

      this.consecutiveAuthFailures++;

      // Log at reduced frequency after the first few failures
      if (this.consecutiveAuthFailures <= 3 || this.consecutiveAuthFailures % 10 === 0) {
        console.warn(
          `[IB-KEEPALIVE] Not authenticated (attempt ${this.consecutiveAuthFailures}):`,
          JSON.stringify(status),
        );
      }

      await this.attemptRecovery();
    } catch (e) {
      this.consecutiveAuthFailures++;
      if (this.consecutiveAuthFailures <= 3 || this.consecutiveAuthFailures % 10 === 0) {
        console.error(`[IB-KEEPALIVE] Auth check error (attempt ${this.consecutiveAuthFailures}):`, e);
      }
    }
  }

  // --------------------------------------------------------- recovery helpers

  /**
   * Attempts to recover the gateway session:
   *   1. Validate SSO token
   *   2. Re-authenticate brokerage session
   *   3. Initialize /portfolio/accounts
   */
  private async attemptRecovery(): Promise<void> {
    try {
      // Step 1: SSO validate
      console.log('[IB-KEEPALIVE] Recovery step 1/3 — SSO validate');
      await ibGatewayFetch(`${this.gatewayUrl}/v1/api/sso/validate`, {
        method: 'GET',
      });
      await this.sleep(RECOVERY_PAUSE_MS);

      // Check if that was enough
      let status = await this.getAuthStatus();
      if (status.authenticated && status.connected) {
        console.log('[IB-KEEPALIVE] SSO validate restored session');
        this.consecutiveAuthFailures = 0;
        await this.initializeAccounts();
        return;
      }

      // Step 2: Reauthenticate
      console.log('[IB-KEEPALIVE] Recovery step 2/3 — reauthenticate');
      await ibGatewayFetch(`${this.gatewayUrl}/v1/api/iserver/reauthenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await this.sleep(5000);

      status = await this.getAuthStatus();
      if (status.authenticated && status.connected) {
        console.log('[IB-KEEPALIVE] Reauthenticate restored session');
        this.consecutiveAuthFailures = 0;
        await this.initializeAccounts();
        return;
      }

      // Step 3: One more SSO validate + wait (sometimes the second attempt works)
      console.log('[IB-KEEPALIVE] Recovery step 3/3 — second SSO validate');
      await ibGatewayFetch(`${this.gatewayUrl}/v1/api/sso/validate`, {
        method: 'GET',
      });
      await this.sleep(RECOVERY_PAUSE_MS);

      status = await this.getAuthStatus();
      if (status.authenticated && status.connected) {
        console.log('[IB-KEEPALIVE] Second SSO validate restored session');
        this.consecutiveAuthFailures = 0;
        await this.initializeAccounts();
        return;
      }

      console.error('[IB-KEEPALIVE] Recovery failed — manual browser login required');
    } catch (e) {
      console.error('[IB-KEEPALIVE] Recovery error:', e);
    }
  }

  /**
   * Calls /portfolio/accounts to initialize the brokerage session.
   * IB Gateway requires this call before any portfolio/order endpoints work.
   */
  async initializeAccounts(): Promise<void> {
    try {
      const res = await ibGatewayFetch(`${this.gatewayUrl}/v1/api/portfolio/accounts`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        this.accountsInitialized = true;
        console.log('[IB-KEEPALIVE] Accounts initialized');
      } else {
        console.warn(`[IB-KEEPALIVE] Accounts init returned ${res.status}`);
      }
    } catch (e) {
      console.warn('[IB-KEEPALIVE] Accounts init failed:', e);
    }
  }

  /** Mark accounts as needing re-initialization (called after auth failure in client) */
  resetAccountsInit(): void {
    this.accountsInitialized = false;
  }

  // ----------------------------------------------------------------- helpers

  private async getAuthStatus(): Promise<{ authenticated: boolean; connected: boolean; competing: boolean }> {
    const res = await ibGatewayFetch(`${this.gatewayUrl}/v1/api/iserver/auth/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      return { authenticated: false, connected: false, competing: false };
    }
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    return {
      authenticated: !!data.authenticated,
      connected: !!data.connected,
      competing: !!data.competing,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
