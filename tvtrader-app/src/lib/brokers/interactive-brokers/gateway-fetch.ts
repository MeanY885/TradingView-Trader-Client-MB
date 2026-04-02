/**
 * interactive-brokers/gateway-fetch.ts
 *
 * Shared fetch wrapper for IB Client Portal Gateway requests.
 * The gateway runs on plain HTTP inside the Docker network,
 * so no special SSL handling is needed.
 */

/**
 * Fetch from the IB Gateway.
 */
export async function ibGatewayFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}
