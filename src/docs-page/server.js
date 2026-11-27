#!/usr/bin/env node
// flop-docs-page: "Ask the FLOP docs". A tiny local web page where a visitor
// types a question and gets an answer from a FLOP-served model, grounded in
// excerpts from Flop's official documentation. The engine lives in engine.js
// and is shared with the X replier.
//
//   flop-docs-page            start on http://127.0.0.1:8787
//   flop-docs-page --refresh  re-fetch the documentation first
//
// Honest limits: it is a testnet toy. The model is small, the retrieval is a
// keyword match, and every answer costs a little test FLOP. It binds to
// localhost unless DOCS_HOST says otherwise. One question is answered at a time.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, earningNotice } from '../core/config.js';
import { checkIdentity } from '../core/chain.js';
import { ensureCorpus, answerQuestion } from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(here, 'public', 'index.html'), 'utf8');

let corpus = null;
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

  lastByIp.set(ip, now);
  busy = true;
  try {
    const a = await answerQuestion(question, { corpus });
    if (a.grounded) answered += 1;
    json(res, 200, { answer: a.answer, sources: a.sources, receipt: a.receipt });
  } catch (err) {
    json(res, 502, { error: `Could not buy an answer: ${err.message.slice(0, 300)}` });
  } finally {
    busy = false;
  }
}

async function main() {
  corpus = await ensureCorpus({ refresh: process.argv.includes('--refresh') });
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
