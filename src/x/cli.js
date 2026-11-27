#!/usr/bin/env node
// flop-x: the X side of the kit. Nothing is posted without an approved draft
// or an explicit auto flag.
//
//   flop-x selftest            check the request signing against X's published example (offline)
//   flop-x me                  who the credentials belong to
//   flop-x drafts [status]     list drafts (draft, approved, posted, rejected)
//   flop-x show <id>           print a draft in full
//   flop-x approve <id>        mark a draft approved
//   flop-x reject <id> [why]   mark a draft rejected
//   flop-x post <id>           post an approved draft (a thread posts in order)
//   flop-x draft "text" [...]  add a draft by hand, one argument per post
//   flop-x mentions [--dry-run] answer new mentions from the docs; drafts, or posts with X_AUTO_REPLY=1

import { cfg } from '../core/config.js';
import { selfTest } from './oauth.js';
import { me, postThread } from './client.js';
import { addDraft, listDrafts, getDraft, updateDraft, formatDraft } from './queue.js';
import { runMentions } from './mentions.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos[0] || 'help';

try {
  switch (cmd) {
    case 'selftest': {
      const r = selfTest();
      console.log(r.ok ? 'OAuth 1.0a signing matches the published example.' : `Signing MISMATCH:\n${r.header}`);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'me': {
      const r = await me();
      console.log(`@${r.data.username} (id ${r.data.id})`);
      break;
    }
    case 'drafts': {
      const list = listDrafts(pos[1] || null);
      if (!list.length) console.log('No drafts.');
      for (const d of list) console.log(formatDraft(d));
      break;
    }
    case 'show': console.log(formatDraft(getDraft(pos[1]), { full: true })); break;
    case 'approve': console.log(formatDraft(updateDraft(pos[1], { status: 'approved' }))); break;
    case 'reject': console.log(formatDraft(updateDraft(pos[1], { status: 'rejected', note: pos.slice(2).join(' ') || null }))); break;
    case 'draft': {
      const posts = pos.slice(1);
      if (!posts.length) throw new Error('Give the post text, one argument per post.');
      console.log(formatDraft(addDraft({ kind: 'manual', posts }), { full: true }));
      break;
    }
    case 'post': {
      const d = getDraft(pos[1]);
      if (d.status !== 'approved') throw new Error(`Draft ${d.id} is "${d.status}"; approve it first (flop-x approve ${d.id}).`);
      const ids = await postThread(d.posts);
      updateDraft(d.id, { status: 'posted', postedIds: ids });
      console.log(`Posted ${ids.length} post${ids.length === 1 ? '' : 's'}: https://x.com/i/status/${ids[0]}`);
      break;
    }
    case 'mentions': {
      const done = await runMentions({ dryRun: flags.has('--dry-run') });
      console.log(JSON.stringify(done, null, 2));
      break;
    }
    default:
      console.log(`flop-x (network ${cfg.network}; auto-post digest: ${cfg.x.autoPostDigest ? 'on' : 'off'}; auto-reply: ${cfg.x.autoReply ? 'on' : 'off'})

  selftest | me | drafts [status] | show <id> | approve <id> | reject <id> [why] | post <id>
  draft "text" ["text" ...] | mentions [--dry-run]

Drafts live in ${cfg.stateDir}/x-queue. See docs/x-agent.md.`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
