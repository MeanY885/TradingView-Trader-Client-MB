/**
 * interactive-brokers/auth.ts
 *
 * Session-based authentication for the IB Client Portal Gateway.
 * The gateway handles auth via manual browser login (with 2FA).
 * This module monitors session status and provides helpers for
 * re-validation and re-authentication.
 *
 * No OAuth, no API keys — authentication is session-based via the gateway.
 */

import { BrokerAuthError } from '../errors';
import { ibGatewayFetch } from './gateway-fetch';

export interface IBAuthStatus {
  authenticated: boolean;
  connected: boolean;
  competing: boolean;
  message?: string;
}

export class IBAuthManager {
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  /**
   * Checks the current authentication status of the gateway session.
   * The user must have logged in via browser at the gateway URL.
   */
  async getAuthStatus(): Promise<IBAuthStatus> {
    const res = await this.gatewayFetch('/v1/api/iserver/auth/status', { method: 'POST' });
    if (!res.ok) {
      return { authenticated: false, connected: false, competing: false, message: `Gateway returned ${res.status}` };
    }
    const data = await res.json() as {
      authenticated?: boolean;
      connected?: boolean;
      competing?: boolean;
      message?: string;
    };
    return {
      authenticated: data.authenticated ?? false,
      connected: data.connected ?? false,
      competing: data.competing ?? false,
      message: data.message,
    };
  }

  /**
   * Validates the SSO session. Call this if authenticated is false after login.
   */
  async validateSso(): Promise<void> {
    await this.gatewayFetch('/v1/api/sso/validate', { method: 'GET' });
  }

  /**
   * Triggers re-authentication of the brokerage session.
   */
  async reauthenticate(): Promise<void> {
    await this.gatewayFetch('/v1/api/iserver/reauthenticate', { method: 'POST' });
  }

  /**
   * Ensures the gateway session is authenticated.
   * Attempts SSO validation and re-auth if not authenticated.
   * Throws BrokerAuthError if the session cannot be established.
   */
  async ensureAuthenticated(): Promise<void> {
    let status = await this.getAuthStatus();
    if (status.authenticated && status.connected) return;

    // Try SSO validation first
    await this.validateSso();
    await this.sleep(2000);

    status = await this.getAuthStatus();
    if (status.authenticated && status.connected) return;

    // Try re-authentication
    await this.reauthenticate();
    await this.sleep(5000);

    status = await this.getAuthStatus();
    if (status.authenticated && status.connected) return;

    throw new BrokerAuthError(
      'interactive_brokers',
      `IB Gateway not authenticated. Please log in at ${this.gatewayUrl} via your browser. Status: ${JSON.stringify(status)}`,
    );
  }

  private async gatewayFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await ibGatewayFetch(`${this.gatewayUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init.headers },
      });
    } catch (e) {
      throw new BrokerAuthError(
        'interactive_brokers',
        `Cannot reach IB Gateway at ${this.gatewayUrl}. Is it running? Error: ${e}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
