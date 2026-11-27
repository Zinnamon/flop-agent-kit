// A minimal X API v2 client: post, reply, thread, read mentions, who am I.
// Credentials come from .env (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
// X_ACCESS_SECRET), which you create in the X developer portal yourself.
// Nothing here is called unless you run the x commands or switch a flag on.

import { cfg } from '../core/config.js';
import { authorizationHeader } from './oauth.js';

const API = 'https://api.x.com/2';

export function xCreds() {
  const c = cfg.x;
  if (!c.apiKey || !c.apiSecret || !c.accessToken || !c.accessSecret) {
    throw new Error('X credentials missing. Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET in .env (see docs/x-agent.md).');
  }
  return c;
}

async function call(method, path, { query, body } = {}) {
  const creds = xCreds();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = {
    authorization: authorizationHeader(method, url.toString(), creds),
    'user-agent': cfg.userAgent,
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json).slice(0, 500) : text.slice(0, 300);
    const err = new Error(`X API ${method} ${path} failed: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    err.rateLimitReset = res.headers.get('x-rate-limit-reset');
    throw err;
  }
  return json;
}

export const me = () => call('GET', '/users/me');

/** Post one tweet; `replyTo` makes it a reply. Returns {id, text}. */
export async function post(text, { replyTo } = {}) {
  if (text.length > 280) throw new Error(`Post is ${text.length} characters; the limit is 280.`);
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
  const r = await call('POST', '/tweets', { body });
  return r.data;
}

/** Post a thread: each post replies to the previous one. Returns the ids in order; stops at the first failure. */
export async function postThread(posts, { pauseMs = 2500 } = {}) {
  const ids = [];
  let prev = null;
  for (const text of posts) {
    const d = await post(text, { replyTo: prev });
    ids.push(d.id);
    prev = d.id;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return ids;
}

/** Mentions of the configured user, newest first, optionally only after `sinceId`. */
export async function mentions(userId, { sinceId, max = 20 } = {}) {
  const r = await call('GET', `/users/${userId}/mentions`, {
    query: {
      since_id: sinceId,
      max_results: Math.min(Math.max(max, 5), 100),
      'tweet.fields': 'author_id,conversation_id,created_at,in_reply_to_user_id',
      expansions: 'author_id',
      'user.fields': 'username',
    },
  });
  const users = Object.fromEntries((r.includes?.users || []).map((u) => [u.id, u.username]));
  return (r.data || []).map((t) => ({ ...t, username: users[t.author_id] || null })).reverse();
}
