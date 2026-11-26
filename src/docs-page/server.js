#!/usr/bin/env node
// flop-docs-page: "Ask the FLOP docs". A tiny local web page where a visitor
// types a question and gets an answer from a FLOP-served model, grounded in
// excerpts from Flop's official documentation.
//
//   flop-docs-page            start on http://127.0.0.1:8787
//   flop-docs-page --refresh  re-fetch the documentation first
//
// Honest limits: it is a testnet toy. The model is small, the retrieval is a
// keyword match, and every answer costs a little test FLOP. It binds to
// localhost unless DOCS_HOST says otherwise. One question is answered at a time.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, earningNotice } from '../core/config.js';
import { explain } from '../core/cli.js';
import { checkIdentity } from '../core/chain.js';
import { ask } from '../core/inference.js';
import { saveReceipt, summariseReceipt, explorerLinks } from '../core/receipt.js';
import { fetchAll } from '../digest/sources.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, 'public', 'index.html'), 'utf8');
const corpusDir = join(cfg.stateDir, 'docs-page');
const corpusPath = join(corpusDir, 'corpus.json');
mkdirSync(corpusDir, { recursive: true, mode: 0o700 });

const STOP = new Set('a an the and or of to in on for is are was be by with as at from that this it its into do does how what when where which who why can i my your you we they not no yes if then than about'.split(' '));
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/** Split a page into paragraph-sized chunks of roughly 300 to 900 characters. */
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

async function buildCorpus() {
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

function loadCorpus() {
  if (!existsSync(corpusPath)) return null;
  try {
    return JSON.parse(readFileSync(corpusPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Keyword retrieval: score each chunk by matching terms, weighted by rarity. */
function retrieve(corpus, question, k = 5, maxChars = 4500) {
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

const SYSTEM = 'You answer questions about the FLOP Network using only the documentation excerpts provided. Answer in plain British English in at most five sentences. If the excerpts do not contain the answer, say "The official docs I have do not answer that" and stop. Name the page you used. Never speculate about rewards, airdrop amounts, token prices or investment. The testnet is unscored and nothing earns anything before an announced activation block.';

let corpus = loadCorpus();
let busy = false;
const lastByIp = new Map();
let answered = 0;

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handleAsk(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  if (now - (lastByIp.get(ip) || 0) < 5000) return json(res, 429, { error: 'One question every five seconds, please.' });
  if (busy) return json(res, 429, { error: 'Answering another question. Try again in a moment.' });
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > 10_000) return json(res, 413, { error: 'Question too long.' });
  }
  let question;
  try {
    question = String(JSON.parse(body).question || '').trim();
  } catch {
    return json(res, 400, { error: 'Send JSON: {"question": "..."}' });
  }
  if (!question || question.length > 500) return json(res, 400, { error: 'Ask one question of up to 500 characters.' });
  if (!corpus) return json(res, 503, { error: 'Documentation not loaded yet.' });

  lastByIp.set(ip, now);
  busy = true;
  try {
    const excerpts = retrieve(corpus, question);
    if (!excerpts.length) return json(res, 200, { answer: 'The official docs I have do not mention those words. Try other terms, for example "faucet", "validator", "miner", "gateway" or "activation block".', sources: [], receipt: null });
    const prompt = `Documentation excerpts:\n\n${excerpts.map((e, i) => `[${i + 1}] ${e.source} (${e.url})\n${e.text}`).join('\n\n')}\n\nQuestion: ${question}\n\nAnswer from the excerpts only.`;
    const result = await ask({ prompt, system: SYSTEM, maxTokens: 350, temperature: 0.2 });
    answered += 1;
    const summary = summariseReceipt(result);
    saveReceipt(result, { purpose: 'docs-page', question });
    json(res, 200, {
      answer: result.text,
      sources: [...new Map(excerpts.map((e) => [e.url, { title: e.source, url: e.url }])).values()],
      receipt: { ...summary, model: result.model, network: cfg.network, route: result.route, links: explorerLinks(summary) },
    });
  } catch (err) {
    json(res, 502, { error: `Could not buy an answer: ${err.message.slice(0, 300)}` });
  } finally {
    busy = false;
  }
}

async function main() {
  if (process.argv.includes('--refresh') || !corpus) corpus = await buildCorpus();
  const rep = await checkIdentity();
  console.log(`Documentation: ${corpus.chunks.length} excerpts from ${corpus.pages.filter((p) => !p.error).length} official pages, fetched ${corpus.builtAt}.`);
  console.log(rep.ok ? `Identity check passed on ${cfg.net.label}; model ${cfg.model}.` : `Identity check FAILED: ${rep.problems.join('; ')}`);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(indexHtml);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { network: cfg.network, label: cfg.net.label, model: cfg.model, route: cfg.route, corpusBuiltAt: corpus.builtAt, pages: corpus.pages, excerpts: corpus.chunks.length, answered, earns: earningNotice(), identityOk: rep.ok });
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') return handleAsk(req, res);
    json(res, 404, { error: 'Not found' });
  });
  server.listen(cfg.docs.port, cfg.docs.host, () => {
    console.log(`Ask the FLOP docs: http://${cfg.docs.host}:${cfg.docs.port}/  (${earningNotice()})`);
  });
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
