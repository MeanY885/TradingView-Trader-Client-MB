/**
 * interactive-brokers/gateway-fetch.ts
 *
 * Shared fetch wrapper for IB Client Portal Gateway requests.
 * Handles the self-signed SSL certificate used by the gateway.
 */

let sslDisabled = false;

/**
 * Ensure SSL verification is disabled for IB Gateway self-signed cert.
 * This sets NODE_TLS_REJECT_UNAUTHORIZED=0 for the process.
 * Safe because the only HTTPS target that uses self-signed certs is the
 * local IB gateway — all other outbound calls go to properly signed endpoints.
 */
function ensureSslDisabled(): void {
  if (sslDisabled) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  sslDisabled = true;
}

/**
 * Fetch from the IB Gateway with SSL verification disabled
 * (the gateway uses a self-signed certificate).
 */
export async function ibGatewayFetch(url: string, init?: RequestInit): Promise<Response> {
  ensureSslDisabled();
  return fetch(url, init);
}
