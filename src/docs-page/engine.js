// The "answer from the official docs" engine, shared by the web page and the X replier.
// Fetch official pages, split into excerpts, pick the excerpts that match a
// question by keyword, and ask a FLOP-served model to answer from them only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from '../core/config.js';
import { explain } from '../core/cli.js';
import { ask } from '../core/inference.js';
import { saveReceipt, summariseReceipt, explorerLinks } from '../core/receipt.js';
import { fetchAll } from '../digest/sources.js';

const corpusDir = join(cfg.stateDir, 'docs-page');
const corpusPath = join(corpusDir, 'corpus.json');
mkdirSync(corpusDir, { recursive: true, mode: 0o700 });

const STOP = new Set('a an the and or of to in on for is are was be by with as at from that this it its into do does how what when where which who why can i my your you we they not no yes if then than about'.split(' '));
export const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

function chunk(text) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}|\n(?=#)/)) {
    const p = para.trim();
    if (!p) continue;
    if ((cur + '\n' + p).length > 900 && cur) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.length > 80).map((c) => (c.length > 1400 ? c.slice(0, 1400) : c));
}

export async function buildCorpus() {
  explain('Fetching the official FLOP documentation pages listed in config/sources.json (read-only).');
  const pages = await fetchAll((s) => s.docs);
  const chunks = [];
  for (const p of pages) {
    if (p.error) continue;
    for (const c of chunk(p.text)) chunks.push({ source: p.title, url: p.url, text: c, terms: [...new Set(tokens(c))] });
  }
  const corpus = { builtAt: new Date().toISOString(), pages: pages.map((p) => ({ title: p.title, url: p.url, error: p.error, chars: p.text.length })), chunks };
  writeFileSync(corpusPath, JSON.stringify(corpus));
  return corpus;
}

export function loadCorpus() {
  if (!existsSync(corpusPath)) return null;
  try {
    return JSON.parse(readFileSync(corpusPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Load the corpus, or build it when missing or older than `maxAgeHours`. */
export async function ensureCorpus({ maxAgeHours = 24, refresh = false } = {}) {
  const c = refresh ? null : loadCorpus();
  if (c && Date.now() - Date.parse(c.builtAt) < maxAgeHours * 3600_000) return c;
  return buildCorpus();
}

export function retrieve(corpus, question, k = 5, maxChars = 4500) {
  const q = [...new Set(tokens(question))];
  if (!q.length) return [];
  const df = new Map();
  for (const c of corpus.chunks) for (const t of c.terms) df.set(t, (df.get(t) || 0) + 1);
  const n = corpus.chunks.length;
  const scored = corpus.chunks.map((c) => {
    let score = 0;
    for (const t of q) {
      if (c.terms.includes(t)) score += Math.log(1 + n / (df.get(t) || 1));
      else if (c.terms.some((x) => x.startsWith(t) || t.startsWith(x))) score += 0.3;
    }
    return { c, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const picked = [];
  let total = 0;
  for (const s of scored) {
    if (picked.length >= k || total + s.c.text.length > maxChars) continue;
    picked.push(s.c);
    total += s.c.text.length;
  }
  return picked;
}

export const SYSTEM = 'You answer questions about the FLOP Network using only the documentation excerpts provided. Answer in plain British English in at most five sentences. If the excerpts do not contain the answer, say "The official docs I have do not answer that" and stop. Name the page you used. Never speculate about rewards, airdrop amounts, token prices or investment. The testnet is unscored and nothing earns anything before an announced activation block.';

/**
 * Answer one question from the docs. Returns {answer, sources, receipt, grounded}.
 * `grounded` is false when no excerpt matched, in which case no inference is bought.
 */
export async function answerQuestion(question, { corpus, maxTokens = 350, maxChars } = {}) {
  const c = corpus || (await ensureCorpus());
  const excerpts = retrieve(c, question, 5, maxChars);
  if (!excerpts.length) {
    return { answer: 'The official docs I have do not mention those words. Try other terms, for example "faucet", "validator", "miner", "gateway" or "activation block".', sources: [], receipt: null, grounded: false };
  }
  const prompt = `Documentation excerpts:\n\n${excerpts.map((e, i) => `[${i + 1}] ${e.source} (${e.url})\n${e.text}`).join('\n\n')}\n\nQuestion: ${question}\n\nAnswer from the excerpts only.`;
  const result = await ask({ prompt, system: SYSTEM, maxTokens, temperature: 0.2 });
  const summary = summariseReceipt(result);
  saveReceipt(result, { purpose: 'docs-answer', question });
  return {
    answer: result.text,
    sources: [...new Map(excerpts.map((e) => [e.url, { title: e.source, url: e.url }])).values()],
    receipt: { ...summary, model: result.model, network: cfg.network, route: result.route, links: explorerLinks(summary) },
    grounded: true,
  };
}
