// The X agent's reply loop: read new mentions, answer the ones that are
// questions from the official docs (bought from a FLOP miner), and queue each
// answer as a draft reply. With X_AUTO_REPLY=1, grounded answers are posted at
// once; everything else waits for you.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from '../core/config.js';
import { explain } from '../core/cli.js';
import { mentions, me, post } from './client.js';
import { addDraft, updateDraft } from './queue.js';
import { answerQuestion, ensureCorpus } from '../docs-page/engine.js';

const statePath = join(cfg.stateDir, 'x-mentions.json');

function loadState() {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  } catch {
    return {};
  }
}
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });

/** Strip handles and links; keep the question. */
function cleanQuestion(text) {
  return String(text).replace(/https?:\/\/\S+/g, '').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
}

/** Fit an answer into one reply, keeping the first source link. */
function toReply(answer, sources, username) {
  const src = sources[0]?.url || '';
  const budget = 280 - (username ? username.length + 2 : 0) - (src ? src.length + 1 : 0) - 20;
  let body = answer.replace(/\s+/g, ' ').trim();
  if (body.length > budget) {
    const cut = body.slice(0, budget);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
    body = (end > budget * 0.5 ? cut.slice(0, end + 1) : cut.slice(0, budget - 1) + '…').trim();
  }
  return `${username ? `@${username} ` : ''}${body}${src ? ` ${src}` : ''} (bot, from the docs)`.trim();
}

export async function runMentions({ maxReplies = cfg.x.maxRepliesPerRun, dryRun = false } = {}) {
  const state = loadState();
  if (!state.userId) {
    const who = await me();
    state.userId = who.data.id;
    state.username = who.data.username;
    saveState(state);
  }
  explain(`Reading new mentions of @${state.username} since ${state.sinceId || 'the start'}.`);
  const list = await mentions(state.userId, { sinceId: state.sinceId, max: 20 });
  if (!list.length) {
    console.log('No new mentions.');
    return [];
  }
  const corpus = await ensureCorpus();
  const done = [];
  let replies = 0;
  for (const t of list) {
    state.sinceId = t.id;
    if (t.author_id === state.userId) continue;
    const q = cleanQuestion(t.text);
    const looksLikeQuestion = /\?|^(how|what|when|where|which|why|who|is|are|can|does|do)\b/i.test(q);
    if (!looksLikeQuestion || q.length < 8) {
      console.log(`skip ${t.id} from @${t.username}: not a question`);
      continue;
    }
    if (replies >= maxReplies) {
      console.log(`stop: ${maxReplies} replies this run already`);
      break;
    }
    if (dryRun) {
      console.log(`would answer ${t.id} from @${t.username}: ${q.slice(0, 120)}`);
      continue;
    }
    const a = await answerQuestion(q, { corpus, maxTokens: 220, maxChars: 3500 });
    const text = toReply(a.answer, a.sources, t.username);
    const draft = addDraft({ kind: 'reply', posts: [text], replyTo: t.id, source: `https://x.com/${t.username}/status/${t.id}`, context: `@${t.username}: ${t.text}` });
    replies += 1;
    let posted = null;
    if (cfg.x.autoReply && a.grounded) {
      posted = await post(text, { replyTo: t.id });
      updateDraft(draft.id, { status: 'posted', postedIds: [posted.id] });
    }
    done.push({ mention: t.id, from: t.username, draft: draft.id, posted: posted?.id || null, grounded: a.grounded, miner: a.receipt?.miner || null });
    console.log(`${posted ? 'replied' : 'drafted'} ${draft.id} for @${t.username}${a.receipt?.miner ? ` (served by ${a.receipt.miner})` : ''}`);
  }
  saveState(state);
  return done;
}
