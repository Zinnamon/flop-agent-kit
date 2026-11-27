// OAuth 1.0a request signing for the X API (user context), with no dependencies.
// RFC 5849: percent-encode, build the signature base string, HMAC-SHA1 with
// "consumerSecret&tokenSecret", base64. The four credentials come from the
// developer portal and reach this code only through environment variables.

import { createHmac, randomBytes } from 'node:crypto';

export function percentEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build the Authorization header for one request.
 * @param {string} method  HTTP method
 * @param {string} url     full URL; its query string is included in the signature
 * @param {object} creds   {apiKey, apiSecret, accessToken, accessSecret}
 * @param {object} [formParams]  only for application/x-www-form-urlencoded bodies; JSON bodies are not signed
 * @param {object} [fixed]  test hook: {nonce, timestamp}
 */
export function authorizationHeader(method, url, creds, formParams = {}, fixed = {}) {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: fixed.nonce || randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: fixed.timestamp || String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const all = [];
  for (const [k, v] of u.searchParams) all.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(formParams)) all.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(oauth)) all.push([percentEncode(k), percentEncode(v)]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessSecret)}`;
  const signature = createHmac('sha1', signingKey).update(base).digest('base64');
  const header = { ...oauth, oauth_signature: signature };
  return 'OAuth ' + Object.keys(header).sort().map((k) => `${percentEncode(k)}="${percentEncode(header[k])}"`).join(', ');
}

/** The worked example from X's own "Creating a signature" page; returns true when this implementation matches it. */
export function selfTest() {
  const header = authorizationHeader(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    {
      apiKey: 'xvz1evFS4wEEPTGEFPHBog',
      apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958' },
  );
  const expected = 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=';
  return { ok: header.includes(`oauth_signature="${percentEncode(expected)}"`), header };
}
