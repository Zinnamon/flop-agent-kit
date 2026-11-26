// Posting to Technocore chat (https://technocore.chat), Flop Labs' HTTP chat for agents.
//
// Rooms are public and world-readable. A post is attributable when it is signed
// with an Ed25519 did:key; the signature covers `<room>|<nonce>|<text>`
// (manual at technocore.chat/llms.txt and /auth.md, read 26 November 2026).
// The kit makes its own Ed25519 key for this, stores it outside the repository
// (mode 600) and never uses the FLOP wallet key for chat. Posting is off unless
// TECHNOCORE_POST=1.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { cfg } from '../core/config.js';
import { fetchJson } from '../core/chain.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/** did:key for an Ed25519 public key: multicodec 0xed01 + 32 raw bytes, base58btc with 'z'. */
export function didFromPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  return 'did:key:z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]));
}

/** Load the kit's chat key, or make one. Returns {did, privateKey}. */
export function loadOrCreateIdentity() {
  const dir = join(cfg.stateDir, 'technocore');
  const keyPath = join(dir, 'ed25519-private.pem');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let privateKey;
  if (existsSync(keyPath)) {
    privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const did = didFromPublicKey(createPublicKey(privateKey));
  return { did, privateKey, keyPath };
}

/** The server stores a single line: every run of whitespace, newlines included, becomes one space. Sign that. */
export function sweep(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function signMessage(privateKey, room, nonce, text) {
  const sig = sign(null, Buffer.from(`${room}|${nonce}|${text}`, 'utf8'), privateKey);
  return sig.toString('base64url');
}

/**
 * Post one signed message. Returns the server's reply.
 * The nonce must exceed the key's last nonce in that room; a millisecond clock does that.
 */
export async function postSigned(text, { room = cfg.technocore.room, identity = loadOrCreateIdentity() } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(room)) throw new Error(`Bad room name "${room}": lowercase letters, digits, - and _ only.`);
  const clean = sweep(text);
  if (!clean || clean.length > 4096) throw new Error('Message must be 1 to 4096 characters after the single-line sweep.');
  const nonce = String(Date.now());
  const sig = signMessage(identity.privateKey, room, nonce, clean);
  const r = await fetchJson(`${cfg.technocore.url}/r/${room}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: identity.did, sig, nonce, text: clean }),
  });
  return { status: r.status, ok: r.ok, body: r.json || r.text.slice(0, 300), room, did: identity.did, nonce };
}

/** Read the newest messages in a room (public). */
export async function readRoom(room = cfg.technocore.room, limit = 20) {
  const r = await fetchJson(`${cfg.technocore.url}/r/${room}?format=json&limit=${limit}`);
  return r.json;
}
