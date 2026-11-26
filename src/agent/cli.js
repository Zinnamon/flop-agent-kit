#!/usr/bin/env node
// flop-agent: the template agent.
//
//   flop-agent status            check chain identity, faucet, gateway and models (read-only)
//   flop-agent claim             claim test FLOP from the faucet with Flop's CLI
//   flop-agent ask "question"    buy one answer from a FLOP miner and print the receipt
//   flop-agent receipt           print the last receipt again
//   flop-agent run ["question"]  status, then claim, then ask, then receipt
//
// Add --json for machine-readable output. Set FLOP_NETWORK=testnet to switch.
//
// Every step prints what it is about to do, in plain words, before doing it.

import { cfg, signerProblems, earningNotice } from '../core/config.js';
import { runFlop, explain } from '../core/cli.js';
import { checkIdentity, formatReport, balance } from '../core/chain.js';
import { ask } from '../core/inference.js';
import { saveReceipt, lastReceipt, formatReceipt, summariseReceipt, explorerLinks } from '../core/receipt.js';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const command = positional[0] || 'help';

const out = (obj, text) => console.log(wantJson ? JSON.stringify(obj, null, 2) : text);

function help() {
  console.log(`flop-agent: a template FLOP agent (network: ${cfg.network})

  status            read-only check of chain identity, faucet, gateway and models
  claim             claim test FLOP from the faucet, signed by Flop's CLI
  ask "question"    buy one answer from a FLOP miner; print the settlement receipt
  receipt           print the last receipt again
  run ["question"]  status, claim, ask, receipt in one go

Options: --json. Settings come from .env (see .env.example); FLOP_NETWORK switches network.
${earningNotice()}`);
}

async function status() {
  explain(`Checking ${cfg.net.label}: RPC block zero, faucet /chain and /limits, gateway /health and /v1/models. Read-only; nothing is signed.`);
  const rep = await checkIdentity();
  out(rep, formatReport(rep));
  console.log(earningNotice());
  return rep;
}

async function claim() {
  const problems = signerProblems();
  if (problems.length) {
    out({ ok: false, problems }, `Cannot claim:\n  ${problems.join('\n  ')}`);
    return { ok: false };
  }
  let r;
  if (cfg.network === 'testnet') {
    explain(`Claiming 10 test FLOP on testnet. The CLI signs a claim with the keystore and sends it to ${cfg.net.faucet}/v1/testnet/agent-claims: flop --network testnet --keystore … --password-env … faucet request`);
    r = await runFlop(['faucet', 'request'], { signer: true });
  } else {
    explain(`Requesting devnet test FLOP for ${cfg.address}. The CLI checks that the faucet and the RPC agree on the chain, then asks ${cfg.net.faucet}: flop --network devnet faucet request ${cfg.address}`);
    r = await runFlop(['faucet', 'request', cfg.address], { signer: false });
  }
  const j = r.json || {};
  const accepted = r.ok && !j.error && j.outcome !== 'refused' && j.success !== false;
  const summary = {
    ok: accepted,
    outcome: j.outcome || (accepted ? 'accepted' : 'refused'),
    txHash: j.txHash || j.tx_hash || j.transaction || null,
    amount: j.amount ?? j.amountFlop ?? null,
    reason: j.reason || j.error || null,
    message: j.message || j.error || (r.ok ? '' : (r.stderr || r.stdout).trim().split('\n').pop()),
    retryAfterSeconds: j.retryAfterSeconds ?? null,
    command: r.command,
  };
  const text = accepted
    ? `Claim accepted${summary.amount ? `: ${summary.amount} FLOP` : ''}${summary.txHash ? `, transaction ${summary.txHash}` : ''}. Treat it as spendable once the transaction is in a finalized block.`
    : `Claim refused: ${summary.reason || ''} ${summary.message || ''}`.trim() + (summary.retryAfterSeconds ? ` (retry after ${summary.retryAfterSeconds} s)` : '') + '\nThat is normal if the last grant was within 24 hours, or if it has not been spent yet. Never retry a refusal in a loop.';
  out({ ...summary, raw: j }, text);
  return summary;
}

async function showBalance() {
  if (!cfg.address) return;
  const r = await balance(cfg.address);
  const j = r.json;
  if (j) {
    const free = j.free ?? j.balance?.free ?? j.freeFlop ?? j.free_flop ?? JSON.stringify(j).slice(0, 200);
    console.log(`Balance of ${cfg.address}: ${asFlop(free)}`);
  }
}

/** Chain balances come in plancks (1 FLOP = 10^18). Show FLOP. */
function asFlop(value) {
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  if (!/^\d+$/.test(s)) return s;
  const whole = s.length > 18 ? s.slice(0, -18) : '0';
  const frac = s.padStart(19, '0').slice(-18).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} FLOP`;
}

async function askCmd(question) {
  if (!question) {
    console.error('Usage: flop-agent ask "your question"');
    process.exit(2);
  }
  const rep = await checkIdentity();
  if (!rep.ok) {
    out(rep, formatReport(rep));
    process.exit(1);
  }
  if (rep.facts.chosenModelServed === false) {
    console.log(formatReport(rep));
    console.log(`No miner is serving ${cfg.model} on ${cfg.net.label} right now, so nothing can be bought. Try again later or pick another model with FLOP_MODEL.`);
    process.exit(1);
  }
  const system = 'You are a FLOP Network test agent. Answer briefly and plainly. Do not speculate about rewards, airdrops or token prices.';
  const result = await ask({ prompt: question, system });
  const path = saveReceipt(result, { question });
  const summary = summariseReceipt(result);
  out(
    { answer: result.text, receipt: summary, links: explorerLinks(summary), raw: result.receipt, savedTo: path },
    `\nAnswer:\n${result.text}\n\n${formatReceipt(result)}\n  saved to:   ${path}\n${earningNotice()}`,
  );
  return result;
}

function receipt() {
  const last = lastReceipt();
  if (!last) {
    console.log('No receipt saved yet. Run: flop-agent ask "a question"');
    return;
  }
  const result = { route: last.route, model: last.model, requestId: last.requestId, receipt: last.receipt, usage: last.usage };
  out(last, `Last receipt, ${last.at}:\n${formatReceipt(result)}`);
}

async function run(question) {
  const rep = await status();
  if (!rep.ok) process.exit(1);
  await claim();
  await showBalance();
  await askCmd(question || 'In two short sentences, what is a compute channel on the FLOP Network?');
}

try {
  switch (command) {
    case 'status': await status(); break;
    case 'claim': await claim(); await showBalance(); break;
    case 'ask': await askCmd(positional.slice(1).join(' ')); break;
    case 'receipt': receipt(); break;
    case 'run': await run(positional.slice(1).join(' ')); break;
    default: help();
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
