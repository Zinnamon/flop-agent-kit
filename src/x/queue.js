// A review queue for anything the kit wants to say on X.
//
// Every candidate post lands here as a draft first: digest threads, receipts,
// replies to mentions. You read it, approve it, and post it; or a flag lets a
// kind of post go out on its own. Drafts live in the state folder, not the repo.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from '../core/config.js';

const dir = join(cfg.stateDir, 'x-queue');
mkdirSync(dir, { recursive: true, mode: 0o700 });

const file = (id) => join(dir, `${id}.json`);

export function addDraft({ kind, posts, replyTo = null, source = null, context = null }) {
  const at = new Date().toISOString();
  const id = `${at.replace(/[-:T]/g, '').slice(0, 14)}-${kind}`;
  const draft = { id, kind, posts, replyTo, source, context, status: 'draft', createdAt: at, postedIds: [], note: null };
  writeFileSync(file(id), JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 });
  return draft;
}

export function listDrafts(status = null) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter((d) => !status || d.status === status);
}

export function getDraft(id) {
  const p = file(id);
  if (!existsSync(p)) throw new Error(`No draft ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function updateDraft(id, patch) {
  const d = { ...getDraft(id), ...patch };
  writeFileSync(file(id), JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
  return d;
}

export function formatDraft(d, { full = false } = {}) {
  const head = `${d.id}  [${d.status}]  ${d.kind}${d.replyTo ? ` reply to ${d.replyTo}` : ''}  ${d.posts.length} post${d.posts.length === 1 ? '' : 's'}`;
  if (!full) return `${head}\n    ${d.posts[0].slice(0, 110)}${d.posts[0].length > 110 ? '…' : ''}`;
  return [head, d.context ? `  context: ${String(d.context).slice(0, 300)}` : null, ...d.posts.map((p, i) => `  --- ${i + 1}/${d.posts.length} (${p.length} chars)\n  ${p}`), d.postedIds.length ? `  posted: ${d.postedIds.join(', ')}` : null].filter(Boolean).join('\n');
}
