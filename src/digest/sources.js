// Fetch Flop's official sources and turn each into plain text that can be
// compared from one day to the next. Only URLs in config/sources.json are read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/config.js';
import { fetchText } from '../core/chain.js';

export const sourceList = JSON.parse(readFileSync(join(repoRoot, 'config', 'sources.json'), 'utf8')).sources;

/** Strip HTML to readable text. Good enough for docs pages; not a browser. */
export function htmlToText(html) {
  let h = String(html);
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|pre|section|article|table|blockquote|dd|dt)>/gi, '\n');
  h = h.replace(/<li[^>]*>/gi, '- ').replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `);
  h = h.replace(/<[^>]+>/g, '');
  h = h.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  h = h.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');
  return h.replace(/\n{3,}/g, '\n\n').trim();
}

// Fields that change every minute and would make every day look different.
const VOLATILE = new Set([
  'asOf', 'stale', 'balanceFlop', 'usedFlop', 'remainingFlop', 'pendingGrants', 'spendableFlop',
  'used', 'active', 'unbonding', 'other', 'uncalibrated', 'sponsored', 'unsponsoredActive', 'ipGrantsPerDay',
]);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!VOLATILE.has(k)) out[k] = stripVolatile(v);
    return out;
  }
  return value;
}

function flatten(obj, prefix = '') {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) lines.push(...flatten(v, key));
    else lines.push(`${key}: ${JSON.stringify(v)}`);
  }
  return lines;
}

function releasesToText(json) {
  if (!Array.isArray(json)) return JSON.stringify(json).slice(0, 2000);
  return json.map((r) => {
    const body = String(r.body || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 700);
    return `## ${r.tag_name} | ${r.name || ''} | published ${r.published_at || r.created_at || '?'}${r.prerelease ? ' | pre-release' : ''}\n${body}`;
  }).join('\n\n');
}

/** Fetch one source. Never throws; errors are recorded on the result. */
export async function fetchSource(src) {
  const result = { id: src.id, title: src.title, url: src.url, kind: src.kind, fetchedAt: new Date().toISOString(), text: '', error: null, status: null };
  try {
    const r = await fetchText(src.url, { timeoutMs: 40_000 });
    result.status = r.status;
    if (!r.ok) {
      result.error = `HTTP ${r.status}`;
      return result;
    }
    switch (src.kind) {
      case 'html': result.text = htmlToText(r.text); break;
      case 'text': result.text = r.text.trim(); break;
      case 'github-releases': result.text = releasesToText(JSON.parse(r.text)); break;
      case 'faucet-limits': result.text = flatten(stripVolatile(JSON.parse(r.text))).join('\n'); break;
      default: result.text = r.text.trim();
    }
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

export async function fetchAll(filter) {
  const chosen = sourceList.filter(filter);
  return Promise.all(chosen.map(fetchSource));
}

/** Line-based differences between two texts. Returns {added, removed}, each capped. */
export function diffLines(oldText, newText, cap = 80) {
  // Very short lines are navigation and punctuation, not facts.
  const keep = (s) => s.length >= 8;
  const a = new Set(String(oldText || '').split('\n').map((s) => s.trim()).filter(keep));
  const b = new Set(String(newText || '').split('\n').map((s) => s.trim()).filter(keep));
  const added = [...b].filter((l) => !a.has(l)).slice(0, cap);
  const removed = [...a].filter((l) => !b.has(l)).slice(0, cap);
  return { added, removed };
}
