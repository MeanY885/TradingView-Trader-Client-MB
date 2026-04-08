/**
 * interactive-brokers/auto-login.ts
 *
 * Automates IB Client Portal Gateway browser login using Puppeteer.
 * When the gateway session expires and SSO recovery fails, this module
 * launches a headless browser, navigates to the SSO login page, enters
 * credentials, and completes authentication — eliminating the need for
 * manual browser login.
 *
 * Paper vs Live mode is detected automatically from the account ID:
 *   - Account IDs starting with "D" (e.g. DUP652326) → Paper mode
 *   - All others → Live mode
 */

import puppeteer from 'puppeteer-core';

const LOGIN_TIMEOUT_MS = 30_000;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';

/** Prevents concurrent login attempts */
let loginInProgress = false;
let lastLoginAttempt = 0;
const MIN_LOGIN_INTERVAL_MS = 60_000; // Don't retry more than once per minute

export interface AutoLoginResult {
  success: boolean;
  message: string;
  duration?: number;
}

/**
 * Determines if the account is a paper trading account.
 * IB paper account IDs start with "D" (e.g. DU, DUP, DF).
 */
function isPaperAccount(accountId: string): boolean {
  return /^D/i.test(accountId.trim());
}

/**
 * Performs an automated browser login to the IB Gateway.
 *
 * @param gatewayUrl - The gateway URL (e.g. https://ib-gateway:5000)
 * @param username - IB username
 * @param password - IB password
 * @param accountId - IB account ID (used to detect paper/live)
 */
export async function performAutoLogin(
  gatewayUrl: string,
  username: string,
  password: string,
  accountId: string,
): Promise<AutoLoginResult> {
  // Guard: don't run concurrently
  if (loginInProgress) {
    return { success: false, message: 'Auto-login already in progress' };
  }

  // Guard: rate limit
  const now = Date.now();
  if (now - lastLoginAttempt < MIN_LOGIN_INTERVAL_MS) {
    const waitSecs = Math.ceil((MIN_LOGIN_INTERVAL_MS - (now - lastLoginAttempt)) / 1000);
    return { success: false, message: `Rate limited — retry in ${waitSecs}s` };
  }

  if (!username || !password) {
    return { success: false, message: 'IB credentials not configured' };
  }

  loginInProgress = true;
  lastLoginAttempt = now;
  const startTime = Date.now();

  let browser;
  try {
    console.log('[IB-AUTO-LOGIN] Starting automated gateway login...');

    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--ignore-certificate-errors',  // Gateway uses self-signed cert
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to SSO login page
    const loginUrl = `${gatewayUrl}/sso/Login?forwardTo=22&RL=1&ip2loc=US`;
    console.log(`[IB-AUTO-LOGIN] Navigating to ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: LOGIN_TIMEOUT_MS });

    // Wait for the login form to be ready
    await page.waitForSelector('input[type="text"][placeholder="Username"]', { timeout: 10_000 });

    // Detect current paper/live toggle state and switch if needed
    const wantPaper = isPaperAccount(accountId);
    const toggleChecked = await page.$eval('#toggle1', (el: Element) => (el as HTMLInputElement).checked).catch(() => false);
    // toggle1 checked = Paper mode, unchecked = Live mode
    if (wantPaper && !toggleChecked) {
      console.log('[IB-AUTO-LOGIN] Switching to Paper mode');
      await page.$eval('#toggle1', (el: Element) => (el as HTMLInputElement).click());
      await sleep(500);
    } else if (!wantPaper && toggleChecked) {
      console.log('[IB-AUTO-LOGIN] Switching to Live mode');
      await page.$eval('#toggle1', (el: Element) => (el as HTMLInputElement).click());
      await sleep(500);
    }

    // Clear and type username
    const usernameInput = await page.$('input[type="text"][placeholder="Username"]');
    if (!usernameInput) throw new Error('Username input not found');
    await usernameInput.click({ clickCount: 3 }); // Select all
    await usernameInput.type(username, { delay: 30 });

    // Clear and type password
    const passwordInput = await page.$('input[type="password"][placeholder="Password"]');
    if (!passwordInput) throw new Error('Password input not found');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: 30 });

    // Click the Login button
    console.log('[IB-AUTO-LOGIN] Submitting login form...');
    await page.click('button[type="submit"]');

    // Wait for navigation — successful login redirects to Dispatcher then shows
    // "Client login succeeds" or remains on the page with 2FA prompt
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});

    // Give the gateway a moment to process
    await sleep(3000);

    // Check the page content for success indicators
    const pageContent = await page.content();
    const pageUrl = page.url();

    if (pageContent.includes('Client login succeeds')) {
      const duration = Date.now() - startTime;
      console.log(`[IB-AUTO-LOGIN] Login successful (${duration}ms)`);
      return { success: true, message: 'Auto-login successful', duration };
    }

    // Check if we hit 2FA — paper accounts typically don't have 2FA,
    // but if they do, we can't automate it
    if (pageContent.includes('Second Factor') || pageContent.includes('security code') || pageContent.includes('notification')) {
      console.warn('[IB-AUTO-LOGIN] 2FA required — cannot automate this step');
      return { success: false, message: 'Login succeeded but 2FA is required — cannot automate' };
    }

    // Check if the login form is still showing (bad credentials)
    if (pageContent.includes('placeholder="Username"') && pageUrl.includes('Dispatcher')) {
      console.error('[IB-AUTO-LOGIN] Login failed — credentials may be incorrect');
      return { success: false, message: 'Login failed — check username/password' };
    }

    // Unknown state — might still be loading
    // Try checking auth status via the API as a final verification
    try {
      const statusPage = await browser.newPage();
      await statusPage.goto(`${gatewayUrl}/v1/api/iserver/auth/status`, {
        waitUntil: 'networkidle2',
        timeout: 10_000,
      });
      const statusText = await statusPage.evaluate(() => document.body.textContent || '');
      if (statusText.includes('"authenticated":true')) {
        const duration = Date.now() - startTime;
        console.log(`[IB-AUTO-LOGIN] Login verified via auth status (${duration}ms)`);
        return { success: true, message: 'Auto-login successful (verified via status)', duration };
      }
    } catch { /* ignore status check failure */ }

    console.warn(`[IB-AUTO-LOGIN] Login result unclear — page URL: ${pageUrl}`);
    return { success: false, message: `Login result unclear — ended at ${pageUrl}` };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[IB-AUTO-LOGIN] Error: ${msg}`);
    return { success: false, message: `Auto-login error: ${msg}` };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    loginInProgress = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
