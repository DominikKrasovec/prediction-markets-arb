/**
 * Kalshi RSA-PSS request signing — canonical impl shared by:
 *   - services/ingestion: REST scraper + WSS lifecycle watcher
 *   - services/arb-solver: WSS CLOB adapter
 *
 * Every authenticated Kalshi request requires three headers:
 *   KALSHI-ACCESS-KEY       — your API Key ID (UUID)
 *   KALSHI-ACCESS-TIMESTAMP — Unix timestamp in milliseconds (string)
 *   KALSHI-ACCESS-SIGNATURE — base64 RSA-PSS SHA-256 signature of:
 *                             `${timestamp}${METHOD}${pathWithoutQuery}`
 *
 * Environment variables (read lazily at signing time, not import time, so a
 * process that imports this without `KALSHI_KEY_ID` set still loads cleanly
 * and only fails when it actually tries to sign):
 *   KALSHI_KEY_ID    — API Key ID (UUID)
 *   KALSHI_KEY_PEM   — PEM-encoded RSA private key (inline, newlines as \n)
 *   KALSHI_KEY_PATH  — path to .key file (used if KALSHI_KEY_PEM is unset)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

let cachedKeyPem: string | null = null;

function getPrivateKeyPem(): string {
  if (cachedKeyPem) return cachedKeyPem;

  if (process.env.KALSHI_KEY_PEM) {
    cachedKeyPem = process.env.KALSHI_KEY_PEM.replace(/\\n/g, '\n');
    return cachedKeyPem;
  }

  const keyPath = process.env.KALSHI_KEY_PATH;
  if (!keyPath) {
    throw new Error('Kalshi auth: set KALSHI_KEY_PEM or KALSHI_KEY_PATH');
  }
  cachedKeyPem = fs.readFileSync(keyPath, 'utf8');
  return cachedKeyPem;
}

/**
 * Sign `text` with RSA-PSS / SHA-256 / salt=digest-length (32 bytes).
 * Returns base64-encoded signature.
 */
function signPss(keyPem: string, text: string): string {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(text, 'utf8');
  sign.end();
  const signature = sign.sign({
    key: keyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

/**
 * Build the three auth headers for a Kalshi REST or WebSocket request.
 *
 * @param method  HTTP method in uppercase, e.g. "GET", "POST"
 * @param path    Full URL path WITHOUT query string, e.g. "/trade-api/v2/markets"
 *                For WebSocket auth, use "/trade-api/ws/v2"
 */
export function createAuthHeaders(method: string, path: string): Record<string, string> {
  const keyId = process.env.KALSHI_KEY_ID;
  if (!keyId) throw new Error('Kalshi auth: KALSHI_KEY_ID is not set');

  const keyPem = getPrivateKeyPem();
  const timestamp = Date.now().toString();
  // Strip query string just in case the caller passed a full path
  const cleanPath = path.split('?')[0];
  const msgString = timestamp + method.toUpperCase() + cleanPath;
  const signature = signPss(keyPem, msgString);

  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

/** True when the minimum env vars for authenticated requests are present. */
export function hasKalshiCredentials(): boolean {
  return !!(
    process.env.KALSHI_KEY_ID &&
    (process.env.KALSHI_KEY_PEM || process.env.KALSHI_KEY_PATH)
  );
}
