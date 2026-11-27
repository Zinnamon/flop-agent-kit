#!/usr/bin/env node
// flop-digest: once a day, read Flop's official sources, ask a FLOP-served model
// what changed since the last run, and write a digest that can be pasted as an
// X thread. Optionally post it to a Technocore room (off by default).
//
//   flop-digest            run once
//   flop-digest --dry-run  fetch and diff, but buy no inference and post nothing
//   flop-digest --force    write a digest even when nothing changed
//
// Output: digests/YYYY-MM-DD.md in the repository (public information only) and
// a snapshot of today's sources in the state folder for tomorrow's comparison.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, repoRoot, earningNotice } from '../core/config.js';
import { explain } from '../core/cli.js';
import { checkIdentity, formatReport } from '../core/chain.js';
import { ask } from '../core/inference.js';
import { saveReceipt, summariseReceipt } from '../core/receipt.js';
import { fetchAll, diffLines } from './sources.js';
import { postSigned, loadOrCreateIdentity } from './technocore.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');

const snapshotDir = join(cfg.stateDir, 'digest');
const snapshotPath = join(snapshotDir, 'latest-snapshot.json');
const digestDir = join(repoRoot, 'digests');
mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
mkdirSync(digestDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const dateWords = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function loadSnapshot() {
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Cut a long text at a sentence end near the limit. */
function clip(text, max) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.slice(0, max - 1) + '…').trim();
}

/** Turn the model's summary bullets and the known facts into posts of at most 270 characters. */
function buildThread(bullets, facts, receiptLine) {
  const posts = [];
  posts.push(clip(`FLOP testnet digest, ${dateWords}. What changed on Flop's official pages since the last check, summarised by a model served on FLOP ${cfg.network}. ${facts.changedCount} of ${facts.sourceCount} sources changed.`, 270));
  for (const b of bullets) posts.push(clip(b, 270));
  if (facts.latestRelease) posts.push(clip(`Latest release on github.com/flop-labs/network: ${facts.latestRelease}.`, 270));
  posts.push(clip(`Testnet is live but unscored: activity before the announced activation block earns nothing, and no block is announced yet. Sources: docs.flop.network, flop.network, github.com/flop-labs. ${receiptLine}`, 270));
  return posts.map((p, i) => `${i + 1}/${posts.length} ${p}`);
}

function extractBullets(text, max = 6) {
  const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 20);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const key = l.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

async function main() {
  explain(`Reading ${cfg.network === 'testnet' ? 'testnet' : 'the'} official FLOP sources listed in config/sources.json. Read-only.`);
  const current = await fetchAll((s) => s.digest);
  const previous = loadSnapshot();

  // What changed, per source.
  const changes = [];
  for (const src of current) {
    if (src.error) {
      changes.push({ id: src.id, title: src.title, url: src.url, error: src.error, added: [], removed: [] });
      continue;
    }
    const before = previous?.sources?.find((p) => p.id === src.id)?.text ?? null;
    const d = before === null ? { added: src.text.split('\n').filter(Boolean).slice(0, 80), removed: [] } : diffLines(before, src.text);
    changes.push({ id: src.id, title: src.title, url: src.url, first: before === null, ...d });
  }
  const changed = changes.filter((c) => c.added.length || c.removed.length);
  const errored = changes.filter((c) => c.error);
  const releases = current.find((s) => s.id === 'github-releases');
  const latestRelease = releases?.text.match(/^## (.+?) \|/m)?.[1] || null;
  const facts = { sourceCount: current.length, changedCount: changed.length, latestRelease, previousRun: previous?.at || null };

  console.log(`Sources read: ${current.length}; changed: ${changed.length}; unreadable: ${errored.length}; previous run: ${facts.previousRun || 'none (first run)'}.`);
  for (const c of changed) console.log(`  ${c.first ? 'new ' : 'changed'} ${c.title}: +${c.added.length} -${c.removed.length} lines`);
  for (const e of errored) console.log(`  unreadable ${e.title}: ${e.error}`);

  if (!changed.length && !force) {
    console.log('Nothing changed since the last run, so no inference is bought and no digest is written. Use --force to write one anyway.');
    saveSnapshot(current);
    return;
  }

  // Build the material for the model: a compact change report.
  let material = '';
  for (const c of changed) {
    material += `\n### ${c.title} (${c.url})${c.first ? ' [first time read]' : ''}\n`;
    if (c.added.length) material += 'Added or new lines:\n' + c.added.map((l) => `+ ${l}`).join('\n').slice(0, 2500) + '\n';
    if (c.removed.length) material += 'Removed lines:\n' + c.removed.map((l) => `- ${l}`).join('\n').slice(0, 1200) + '\n';
  }
  material = material.slice(0, 14_000);

  let summaryText = '';
  let receiptLine = '';
  let result = null;
  if (dryRun) {
    console.log('\n--dry-run: no inference bought. Material that would be summarised:\n' + material.slice(0, 3000));
  } else {
    const rep = await checkIdentity();
    if (!rep.ok) {
      console.log(formatReport(rep));
      process.exit(1);
    }
    const system = 'You summarise changes on the FLOP Network\'s official documentation for a daily digest. Use only the material given. Write 3 to 6 short bullet points in plain British English, one fact per bullet, each under 240 characters. Name the page a fact comes from. Do not mention rewards, airdrops, token prices or investment. Do not invent anything that is not in the material. If the material shows no substantive change, say so in one bullet.';
    const prompt = `Date: ${dateWords}. Network pages read: FLOP testnet and devnet official docs.\n\nMaterial (lines added or removed since the previous check):\n${material}\n\nWrite the bullet points now.`;
    result = await ask({ prompt, system, maxTokens: 500, temperature: 0.2 });
    summaryText = result.text;
    const s = summariseReceipt(result);
    saveReceipt(result, { purpose: 'digest', date: today });
    receiptLine = `Summarised by ${result.model} on FLOP ${cfg.network}${s.miner ? `, served by miner ${s.miner}` : ''}${s.requestId ? `, request ${s.requestId}` : ''}.`;
  }

  const bullets = summaryText ? extractBullets(summaryText) : changed.slice(0, 5).map((c) => `${c.title} changed: ${c.added[0] || c.removed[0] || ''}`);
  const thread = buildThread(bullets, facts, receiptLine || 'No inference was bought in this run.');

  const md = [
    `# FLOP testnet digest, ${dateWords}`,
    '',
    `Generated by flop-agent-kit from official FLOP sources only. ${earningNotice()}`,
    previous ? `Compared with the previous run at ${previous.at}.` : 'First run: every source counts as new.',
    '',
    '## Summary (written by a FLOP-served model)',
    '',
    summaryText ? summaryText.trim() : '_No inference bought in this run (dry run)._',
    '',
    receiptLine ? `_${receiptLine}_` : '',
    '',
    '## X thread (paste as is)',
    '',
    ...thread.map((p) => p + '\n'),
    '## What changed, by source (mechanical diff, not model output)',
    '',
    ...changes.flatMap((c) => {
      const head = `### ${c.title}\n${c.url}\n`;
      if (c.error) return [head, `Unreadable this run: ${c.error}\n`];
      if (!c.added.length && !c.removed.length) return [head, 'No change.\n'];
      const lines = [head];
      if (c.first) lines.push('_First time read; the lines below are the current page, not a change._\n');
      if (c.added.length) lines.push('```diff\n' + c.added.slice(0, 40).map((l) => `+ ${l}`).join('\n') + (c.added.length > 40 ? `\n+ … ${c.added.length - 40} more lines` : '') + '\n```\n');
      if (c.removed.length) lines.push('```diff\n' + c.removed.slice(0, 20).map((l) => `- ${l}`).join('\n') + (c.removed.length > 20 ? `\n- … ${c.removed.length - 20} more lines` : '') + '\n```\n');
      return lines;
    }),
    '## Sources',
    '',
    ...current.map((s) => `- [${s.title}](${s.url}) read ${s.fetchedAt}${s.error ? ` (unreadable: ${s.error})` : ''}`),
    '',
  ].join('\n');

  const outPath = join(digestDir, `${today}.md`);
  writeFileSync(outPath, md);
  console.log(`\nDigest written to ${outPath}`);
  console.log('\n' + thread.join('\n\n'));

  if (!dryRun) {
    // Every thread becomes an X draft for review; it is posted only with X_AUTO_POST_DIGEST=1.
    try {
      const { addDraft, updateDraft } = await import('../x/queue.js');
      const draft = addDraft({ kind: 'digest', posts: thread, source: outPath });
      console.log(`\nX draft saved: ${draft.id} (review with: npm run x -- show ${draft.id})`);
      if (cfg.x.autoPostDigest && summaryText) {
        const { postThread } = await import('../x/client.js');
        explain(`Posting the ${thread.length}-post digest thread to X (X_AUTO_POST_DIGEST=1).`);
        const ids = await postThread(thread);
        updateDraft(draft.id, { status: 'posted', postedIds: ids });
        console.log(`Posted to X: https://x.com/i/status/${ids[0]}`);
      }
    } catch (err) {
      console.log(`X step skipped: ${err.message.slice(0, 200)}`);
    }
    if (cfg.technocore.post) {
      const identity = loadOrCreateIdentity();
      explain(`Posting ${thread.length} signed messages to Technocore room "${cfg.technocore.room}" as ${identity.did}. Rooms are public.`);
      for (const p of thread) {
        const r = await postSigned(p, { identity });
        console.log(`  ${r.ok ? 'posted' : `refused (${r.status})`}: ${String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 120)}`);
        if (!r.ok) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      console.log(`Room: ${cfg.technocore.url}/r/${cfg.technocore.room}`);
    } else {
      console.log('\nTechnocore posting is off (TECHNOCORE_POST=0). Nothing was published.');
    }
    saveSnapshot(current);
  }
}

function saveSnapshot(current) {
  writeFileSync(snapshotPath, JSON.stringify({ at: new Date().toISOString(), sources: current.map((s) => ({ id: s.id, url: s.url, text: s.text, fetchedAt: s.fetchedAt, error: s.error })) }, null, 1), { mode: 0o600 });
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
