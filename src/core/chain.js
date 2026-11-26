// Read-only checks of the chain, the faucet and the gateway.
//
// Everything here is a plain HTTPS GET or a JSON-RPC read. Nothing signs,
// nothing spends. The identity check follows flop.network/llms.txt: compare the
// faucet's reported genesis hash with block zero on the RPC before doing
// anything else, and stop on any mismatch.

import { cfg } from './config.js';
import { runFlop } from './cli.js';

export async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'user-agent': cfg.userAgent, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null; callers see the raw text
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

export async function fetchText(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'user-agent': cfg.userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, ok: res.ok, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

/** chain_getBlockHash(0) over HTTP JSON-RPC. */
export async function rpcGenesis(net = cfg.net) {
  const r = await fetchJson(net.rpcHttp, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }),
  });
  return r.json?.result ?? null;
}

export async function rpcCall(method, params = [], net = cfg.net) {
  const r = await fetchJson(net.rpcHttp, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json?.result ?? null;
}

export const faucetChain = (net = cfg.net) => fetchJson(`${net.faucet}/chain`);
export const faucetLimits = (net = cfg.net) => fetchJson(`${net.faucet}/limits`);
export const gatewayHealth = (net = cfg.net) => fetchJson(`${net.gateway}/health`);
export const gatewayModels = (net = cfg.net) => fetchJson(`${net.gateway}/v1/models`);

/**
 * The full identity and readiness check. Returns a structured report with
 * `ok` (safe to sign and spend), `problems` (hard stops) and `notes`.
 */
export async function checkIdentity(net = cfg.net, model = cfg.model) {
  const report = { network: cfg.network, label: net.label, ok: true, problems: [], notes: [], facts: {} };
  const stop = (msg) => { report.ok = false; report.problems.push(msg); };

  const [genesis, chain, limits, health, models] = await Promise.allSettled([
    rpcGenesis(net), faucetChain(net), faucetLimits(net), gatewayHealth(net), gatewayModels(net),
  ]);

  // 1. RPC block zero must be the published genesis.
  if (genesis.status !== 'fulfilled' || !genesis.value) stop(`RPC ${net.rpcHttp} did not return block zero.`);
  else {
    report.facts.rpcGenesis = genesis.value;
    if (genesis.value.toLowerCase() !== net.genesisHash.toLowerCase()) stop(`RPC genesis ${genesis.value} differs from the published ${net.genesisHash}.`);
  }

  // 2. Faucet must serve this network and the same genesis.
  if (chain.status !== 'fulfilled' || !chain.value.json) stop(`Faucet ${net.faucet}/chain unreachable.`);
  else {
    const c = chain.value.json;
    report.facts.faucetNetwork = c.network;
    report.facts.faucetGenesis = c.genesisHash;
    if (c.network !== cfg.network) stop(`Faucet reports network "${c.network}", expected "${cfg.network}".`);
    if ((c.genesisHash || '').toLowerCase() !== net.genesisHash.toLowerCase()) stop('Faucet genesis differs from the published genesis.');
    if (c.technocoreBot) report.facts.technocoreBot = c.technocoreBot;
  }

  // 3. Faucet status and the agent tier.
  if (limits.status === 'fulfilled' && limits.value.json?.faucet) {
    const f = limits.value.json.faucet;
    report.facts.faucetStatus = f.status;
    report.facts.faucetAgentTier = f.agent || null;
    report.facts.faucetAsOf = limits.value.json.asOf;
    if (f.status !== 'open') report.notes.push(`Faucet status is "${f.status}", so a claim will be refused for now.`);
    if (f.agent?.rolloverRequiresSpend) report.notes.push('The faucet gives the next agent grant only after the last one was spent on chain.');
  } else report.notes.push('Faucet /limits unreadable; a claim may be refused.');

  // 4. Gateway health and models.
  if (health.status === 'fulfilled' && health.value.json) {
    const h = health.value.json;
    report.facts.gatewayStatus = h.status;
    report.facts.gatewayNetwork = h.network?.network;
    report.facts.gatewayGenesis = h.network?.observed_genesis_hash;
    if (h.network?.network && h.network.network !== cfg.network) stop(`Gateway ${net.gateway} serves "${h.network.network}", not "${cfg.network}".`);
    if (h.network?.observed_genesis_hash && h.network.observed_genesis_hash.toLowerCase() !== net.genesisHash.toLowerCase()) stop('Gateway genesis differs from the published genesis.');
  } else report.notes.push(`Gateway ${net.gateway}/health unreachable.`);

  if (models.status === 'fulfilled' && models.value.json?.data) {
    const list = models.value.json.data;
    report.facts.models = list.map((m) => ({
      id: m.id,
      name: m.name,
      servingMiners: (m['x-flop']?.price_sources || []).length,
      promptPriceFlopPerToken: m.pricing?.prompt,
    }));
    const chosen = list.find((m) => m.id === model);
    if (!chosen) report.notes.push(`Model "${model}" is not in the gateway catalogue. Served models: ${list.map((m) => m.id).join(', ') || 'none'}.`);
    else if (!(chosen['x-flop']?.price_sources || []).length) report.notes.push(`Model "${model}" is listed but no miner is serving it, so inference will fail.`);
    report.facts.chosenModelServed = Boolean(chosen && (chosen['x-flop']?.price_sources || []).length);
  } else report.notes.push(`Gateway model list unreadable (${models.status === 'fulfilled' ? `HTTP ${models.value.status}` : models.reason?.message}).`);

  return report;
}

/** Account balance through the CLI (a public read; no signer). */
export async function balance(address = cfg.address) {
  const r = await runFlop(['balance', address], { signer: false });
  return r;
}

/** Turn a report into lines for people. */
export function formatReport(rep) {
  const lines = [];
  lines.push(`Network: ${rep.label} (${rep.network})`);
  lines.push(`RPC genesis: ${rep.facts.rpcGenesis || 'unknown'}`);
  lines.push(`Faucet: ${rep.facts.faucetNetwork || '?'} / ${rep.facts.faucetStatus || '?'}${rep.facts.faucetAgentTier ? ` / agent tier ${rep.facts.faucetAgentTier.grantFlop} FLOP per ${Math.round((rep.facts.faucetAgentTier.cooldownSeconds || 0) / 3600)} h` : ''}`);
  lines.push(`Gateway: ${rep.facts.gatewayNetwork || '?'} / ${rep.facts.gatewayStatus || '?'}`);
  if (rep.facts.models) {
    for (const m of rep.facts.models) lines.push(`  model ${m.id}: ${m.servingMiners} serving miner${m.servingMiners === 1 ? '' : 's'}`);
  }
  for (const n of rep.notes) lines.push(`note: ${n}`);
  for (const p of rep.problems) lines.push(`STOP: ${p}`);
  lines.push(rep.ok ? 'Identity check passed.' : 'Identity check FAILED. Nothing will be signed or spent.');
  return lines.join('\n');
}
