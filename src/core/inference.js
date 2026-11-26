// Buying inference from FLOP miners. Two routes, one setting (FLOP_ROUTE).
//
// gateway: the OpenAI-compatible FLOP gateway. The key is provisioned by Flop's
//          CLI (`flop agent credential`), signed by the agent's wallet. The
//          gateway tells us which miner served the request in `x_flop_receipt`.
// session: a direct compute channel with one named miner, run by the CLI
//          (`flop session run`). The wallet pays the miner; the result names the
//          settlement transaction. Needs a miner endpoint the agent can reach.
//
// Both routes are taken from docs.flop.network and the CLI's own --help,
// read on 26 November 2026.

import { cfg } from './config.js';
import { runFlop, explain } from './cli.js';
let cachedKey = null;

/**
 * Get a gateway bearer key. Held in memory for this process only.
 * Prefers FLOP_GATEWAY_KEY if set; otherwise asks the CLI, which signs the
 * enrolment challenge with the agent's wallet and reuses an existing key.
 */
export async function getGatewayKey() {
  if (cachedKey) return cachedKey;
  if (cfg.gatewayKey) {
    cachedKey = cfg.gatewayKey.trim();
    return cachedKey;
  }
  explain(`Asking Flop's CLI for a gateway key: flop --network ${cfg.network} --keystore … --password-env … agent credential --print-key (the wallet signs an enrolment challenge; the key is kept in memory only).`);
  const r = await runFlop(['agent', 'credential', '--print-key'], { signer: true, json: false });
  if (!r.ok) {
    throw new Error(`Could not provision a gateway key.\n${(r.stderr || r.stdout).trim().slice(0, 1200)}`);
  }
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const key = lines[lines.length - 1];
  if (!key || key.length < 16) throw new Error('The CLI printed no key.');
  cachedKey = key;
  return key;
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Chat completion through the gateway.
 * @returns {Promise<{text: string, model: string, requestId: string|null, receipt: object|null, usage: object|null, raw: object}>}
 */
export async function chatGateway({ messages, model = cfg.model, maxTokens = cfg.maxTokens, temperature, stream = true }) {
  const key = await getGatewayKey();
  const body = { model, messages, max_tokens: maxTokens, stream };
  if (temperature !== undefined) body.temperature = temperature;
  explain(`Buying one answer from ${model} through the FLOP gateway at ${cfg.net.gateway} (POST /v1/chat/completions, max ${maxTokens} tokens${stream ? ', streamed' : ''}).`);
  const res = await fetch(`${cfg.net.gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      'user-agent': cfg.userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway refused the request (HTTP ${res.status}): ${text.slice(0, 600)}`);
  }
  const requestIdHeader = res.headers.get('x-request-id');

  if (!stream) {
    const j = await res.json();
    return {
      route: 'gateway',
      text: stripThinking(j?.choices?.[0]?.message?.content ?? ''),
      model: j?.model || model,
      requestId: j?.id || requestIdHeader || null,
      receipt: j?.x_flop_receipt || j?.flop_receipt || null,
      usage: j?.usage || null,
      raw: j,
    };
  }

  // Server-sent events: collect the text deltas; the last chunk carries usage and the receipt.
  let content = '';
  let last = null;
  let id = null;
  let receipt = null;
  let usage = null;
  for await (const event of sseEvents(res.body)) {
    if (event === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(event);
    } catch {
      continue;
    }
    last = chunk;
    id = id || chunk.id || null;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) content += delta;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.x_flop_receipt) receipt = chunk.x_flop_receipt;
    if (chunk.error) throw new Error(`Gateway stream error: ${JSON.stringify(chunk.error)}`);
  }
  return {
    route: 'gateway',
    text: stripThinking(content),
    model: last?.model || model,
    requestId: id || requestIdHeader || null,
    receipt,
    usage,
    raw: last,
  };
}

/** Yield the data payload of each server-sent event from a web ReadableStream. */
async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  if (tail) yield tail;
}

/**
 * Direct session with a named miner, run by the CLI. The escrow (--max-flop)
 * is the whole payment: cooperative settlement pays the miner all of it.
 */
export async function chatSession({ prompt, model = cfg.model, maxTokens = cfg.maxTokens }) {
  if (!cfg.miner || !cfg.endpoint) {
    throw new Error('FLOP_ROUTE=session needs FLOP_MINER and FLOP_ENDPOINT (a miner endpoint you can reach).');
  }
  explain(`Opening a direct compute channel with miner ${cfg.miner} for ${model}: flop session run --via auto --max-flop ${cfg.maxFlop} (that escrow is the whole payment, plus a transaction fee).`);
  const r = await runFlop([
    'session', 'run',
    '--miner', cfg.miner,
    '--model', model,
    '--prompt', prompt,
    '--max-flop', String(cfg.maxFlop),
    '--max-tokens', String(maxTokens),
    '--via', 'auto',
    '--endpoint', cfg.endpoint,
  ], { signer: true, timeoutMs: 600_000 });
  if (!r.ok || !r.json) {
    throw new Error(`Direct session failed.\n${(r.stderr || r.stdout).trim().slice(0, 1500)}`);
  }
  const j = r.json;
  // The CLI's JSON names the reply, serving miner, channel, verified turns and settlement.
  const text = stripThinking(j.reply ?? j.output ?? j.text ?? j.response ?? '');
  return {
    route: 'session',
    text,
    model,
    requestId: j.channel ?? j.channelId ?? null,
    receipt: j,
    usage: null,
    raw: j,
  };
}

/** Errors worth one more try: a miner offer expired, an upstream timeout, a busy origin. Never a refusal. */
function isTransient(err) {
  const m = String(err?.message || '');
  return /provider_error|standing offer|HTTP 5\d\d|524|502|503|timed out|TimeoutError|ECONNRESET|terminated/i.test(m) && !/HTTP 40\d/.test(m);
}

/** One call, either route. `system` is optional. Transient gateway errors are retried a few times, with a pause. */
export async function ask({ prompt, system, maxTokens, temperature, model, attempts = 3 }) {
  if (cfg.route === 'session') {
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    return chatSession({ prompt: fullPrompt, maxTokens, model });
  }
  if (cfg.route !== 'gateway') throw new Error(`FLOP_ROUTE must be gateway or session, not "${cfg.route}".`);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await chatGateway({ messages, maxTokens, temperature, model });
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts) throw err;
      const wait = 20_000 * i;
      explain(`The gateway could not place the request this time (${err.message.slice(0, 160)}). Waiting ${wait / 1000} s and trying once more (${i} of ${attempts - 1} retries).`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
