// Shared configuration for every program in the kit.
//
// Settings come from environment variables, optionally loaded from a .env file
// in the repository root (git-ignored). One setting, FLOP_NETWORK, switches the
// whole kit between devnet and testnet.
//
// This module never reads the keystore or the password. It only checks that the
// files exist and are private, and tells the CLI where they are.

import { existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.error(`Could not read ${envFile}: ${err.message}`);
  }
}

export const networks = JSON.parse(readFileSync(join(repoRoot, 'config', 'networks.json'), 'utf8'));

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const network = (process.env.FLOP_NETWORK || 'devnet').trim().toLowerCase();
if (!networks[network]) {
  console.error(`FLOP_NETWORK must be devnet or testnet, not "${network}".`);
  process.exit(2);
}

export const cfg = {
  network,
  net: networks[network],
  keystore: expandHome(process.env.FLOP_KEYSTORE || ''),
  passwordFile: expandHome(process.env.FLOP_PASSWORD_FILE || ''),
  address: (process.env.FLOP_ADDRESS || '').trim(),
  model: process.env.FLOP_MODEL || 'qwen/qwen2.5-0.5b-instruct',
  route: (process.env.FLOP_ROUTE || 'gateway').trim().toLowerCase(),
  miner: (process.env.FLOP_MINER || '').trim(),
  endpoint: (process.env.FLOP_ENDPOINT || '').trim(),
  maxFlop: process.env.FLOP_MAX_FLOP || '0.01',
  maxTokens: Number(process.env.FLOP_MAX_TOKENS || 600),
  gatewayKey: process.env.FLOP_GATEWAY_KEY || '',
  pinMiner: (process.env.FLOP_PIN_MINER || '').trim(),
  // 0.10.2 (published 26 November 2026) is the first release whose README says
  // `agent credential` runs on testnet; the docs' pin was still 0.9.0 that day.
  cliPackage: process.env.FLOP_CLI_PACKAGE || '@flop-labs/cli@0.10.2',
  stateDir: expandHome(process.env.KIT_STATE_DIR || '~/.local/state/flop-agent-kit'),
  technocore: {
    url: (process.env.TECHNOCORE_URL || 'https://technocore.chat').replace(/\/$/, ''),
    room: process.env.TECHNOCORE_ROOM || 'flop-testnet-digest',
    post: process.env.TECHNOCORE_POST === '1',
  },
  docs: {
    host: process.env.DOCS_HOST || '127.0.0.1',
    port: Number(process.env.DOCS_PORT || 8787),
  },
  x: {
    apiKey: process.env.X_API_KEY || '',
    apiSecret: process.env.X_API_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessSecret: process.env.X_ACCESS_SECRET || '',
    autoPostDigest: process.env.X_AUTO_POST_DIGEST === '1',
    autoReply: process.env.X_AUTO_REPLY === '1',
    maxRepliesPerRun: Number(process.env.X_MAX_REPLIES_PER_RUN || 5),
  },
  userAgent: 'flop-agent-kit/0.1',
};

mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });

/** Is the file readable by its owner only (mode 600 or stricter)? */
export function isPrivateFile(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Check that the signer files are in place without opening them.
 * Returns a list of problems; an empty list means the CLI can sign.
 */
export function signerProblems() {
  const problems = [];
  if (!cfg.keystore) problems.push('FLOP_KEYSTORE is not set.');
  else if (!existsSync(cfg.keystore)) problems.push(`Keystore not found: ${cfg.keystore}`);
  else if (!isPrivateFile(cfg.keystore)) problems.push(`Keystore must be owner-only: chmod 600 '${cfg.keystore}'`);
  if (!cfg.passwordFile) problems.push('FLOP_PASSWORD_FILE is not set.');
  else if (!existsSync(cfg.passwordFile)) problems.push(`Password file not found: ${cfg.passwordFile}`);
  else if (!isPrivateFile(cfg.passwordFile)) problems.push(`Password file must be owner-only: chmod 600 '${cfg.passwordFile}'`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(cfg.address)) problems.push('FLOP_ADDRESS does not look like an SS58 address.');
  return problems;
}

/** Plain-English line about what the chosen network earns. Printed often, on purpose. */
export function earningNotice() {
  return `On ${cfg.net.label} this earns ${cfg.net.earns}`;
}
