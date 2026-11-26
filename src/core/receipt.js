// Settlement receipts: what was bought, from whom, and where to see it.

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from './config.js';

const dir = join(cfg.stateDir, 'receipts');

/** Save a receipt as JSON in the state folder (outside the repository). Returns the path. */
export function saveReceipt(result, extra = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  const record = {
    at,
    network: cfg.network,
    route: result.route,
    model: result.model,
    requestId: result.requestId,
    receipt: result.receipt,
    usage: result.usage,
    ...extra,
  };
  const path = join(dir, `${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export function lastReceipt() {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

/** Pull the fields people care about out of whatever the gateway or CLI returned. */
export function summariseReceipt(result) {
  const rc = result.receipt || {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), rc);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  return {
    miner: pick('miner', 'miner_address', 'serving_miner', 'servingMiner'),
    channel: pick('channel', 'channel_id', 'channelId', 'settlement.channel', 'settlement.channelId'),
    txHash: pick('settlement_tx', 'settlementTx', 'settlement.extrinsicHash', 'settlement.txHash', 'tx_hash', 'txHash', 'extrinsic_hash', 'extrinsicHash'),
    turns: pick('verified_turns', 'verifiedTurns', 'turns'),
    paidFlop: pick('paid_flop', 'paidFlop', 'minerPaid', 'cost_flop', 'cost.flop', 'cost'),
    requestId: result.requestId,
  };
}

/** Explorer links for this network. The devnet explorer has an account page; channel rows are in its API. */
export function explorerLinks(summary) {
  const net = cfg.net;
  const links = [];
  if (cfg.address && net.explorerAccount) links.push({ label: 'your account on the explorer', url: net.explorerAccount.replace('{address}', cfg.address) });
  if (summary.miner && net.explorerAccount && net.explorerAccount.includes('{address}')) links.push({ label: 'the serving miner on the explorer', url: net.explorerAccount.replace('{address}', summary.miner) });
  if (summary.channel && net.explorerApi) links.push({ label: 'the compute channel row (API)', url: `${net.explorerApi}/compute-channels?channelId=${encodeURIComponent(summary.channel)}` });
  if (summary.miner && net.explorerApi) links.push({ label: "this miner's settled channels (API)", url: `${net.explorerApi}/compute-channels?miner=${encodeURIComponent(summary.miner)}&status=settled&limit=5` });
  links.push({ label: 'explorer home', url: net.explorer });
  return links;
}

export function formatReceipt(result) {
  const s = summariseReceipt(result);
  const lines = [];
  lines.push('Receipt');
  lines.push(`  network:    ${cfg.net.label}`);
  lines.push(`  route:      ${result.route}`);
  lines.push(`  model:      ${result.model}`);
  if (s.miner) lines.push(`  miner:      ${s.miner}`);
  if (s.channel) lines.push(`  channel:    ${s.channel}`);
  if (s.txHash) lines.push(`  settlement: ${s.txHash}`);
  if (s.turns !== null) lines.push(`  turns:      ${s.turns}`);
  if (s.paidFlop !== null) lines.push(`  paid:       ${typeof s.paidFlop === 'object' ? JSON.stringify(s.paidFlop) : s.paidFlop}`);
  if (s.requestId) lines.push(`  request:    ${s.requestId}`);
  if (result.usage) lines.push(`  tokens:     ${result.usage.prompt_tokens ?? '?'} in, ${result.usage.completion_tokens ?? '?'} out`);
  if (result.receipt) {
    const known = new Set(['miner', 'channel', 'channel_id', 'settlement_tx', 'tx_hash', 'verified_turns', 'paid_flop']);
    const rest = Object.entries(result.receipt).filter(([k]) => !known.has(k));
    if (rest.length) lines.push(`  details:    ${JSON.stringify(Object.fromEntries(rest)).slice(0, 600)}`);
  }
  for (const l of explorerLinks(s)) lines.push(`  ${l.label}: ${l.url}`);
  return lines.join('\n');
}
