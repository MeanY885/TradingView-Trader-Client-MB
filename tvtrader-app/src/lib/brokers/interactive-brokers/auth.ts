/**
 * interactive-brokers/auth.ts
 *
 * OAuth 2.0 authentication for the IB Web API using private_key_jwt.
 * Manages token lifecycle: generates JWT assertions, exchanges for access tokens,
 * and refreshes proactively before expiry.
 */

import * as crypto from 'crypto';

interface TokenInfo {
  accessToken: string;
  accessTokenSecret: string;
  expiresAt: number; // ms timestamp
}

interface IBAuthConfig {
  consumerKey: string;
  privateKeyPem: string;
  tokenUrl?: string;
}

const DEFAULT_TOKEN_URL = 'https://api.ibkr.com/v1/api/oauth/token';

export class IBAuthManager {
  private config: IBAuthConfig;
  private tokenInfo: TokenInfo | null = null;

  constructor(config: IBAuthConfig) {
    this.config = config;
  }

  /**
   * Returns a valid access token, refreshing if needed.
   */
  async getAccessToken(): Promise<{ accessToken: string; accessTokenSecret: string }> {
    if (this.tokenInfo && Date.now() < this.tokenInfo.expiresAt) {
      return {
        accessToken: this.tokenInfo.accessToken,
        accessTokenSecret: this.tokenInfo.accessTokenSecret,
      };
    }
    return this.refreshToken();
  }

  /**
   * Forces a token refresh. Used when a 401 is received.
   */
  async refreshToken(): Promise<{ accessToken: string; accessTokenSecret: string }> {
    const assertion = this.buildJwtAssertion();
    const tokenUrl = this.config.tokenUrl || DEFAULT_TOKEN_URL;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`IB OAuth token request failed (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      access_token: string;
      access_token_secret: string;
      expires_in?: number;
    };

    // Default expiry: 1 hour. Refresh at 80% of expiry time.
    const expiresInMs = (data.expires_in || 3600) * 1000;
    const refreshBuffer = expiresInMs * 0.2;

    this.tokenInfo = {
      accessToken: data.access_token,
      accessTokenSecret: data.access_token_secret,
      expiresAt: Date.now() + expiresInMs - refreshBuffer,
    };

    return {
      accessToken: this.tokenInfo.accessToken,
      accessTokenSecret: this.tokenInfo.accessTokenSecret,
    };
  }

  /**
   * Builds a signed JWT assertion for the private_key_jwt flow.
   */
  private buildJwtAssertion(): string {
    const tokenUrl = this.config.tokenUrl || DEFAULT_TOKEN_URL;
    const now = Math.floor(Date.now() / 1000);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iss: this.config.consumerKey,
      sub: this.config.consumerKey,
      aud: tokenUrl,
      iat: now,
      exp: now + 300, // 5 minutes
      jti: crypto.randomUUID(),
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(this.config.privateKeyPem);
    const encodedSignature = base64url(signature);

    return `${signingInput}.${encodedSignature}`;
  }

  /**
   * Invalidates cached token, forcing re-auth on next call.
   */
  invalidate(): void {
    this.tokenInfo = null;
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}
