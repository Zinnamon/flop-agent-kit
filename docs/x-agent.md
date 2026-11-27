# The X agent

The kit can run your X account's FLOP side: post the daily digest thread,
answer questions people ask you about FLOP from the official docs (the answer
bought from a FLOP miner), and keep every post in a review queue you control.

It is deliberately not a spam machine. Flop forfeits manufactured activity, and
X suspends accounts that automate without disclosure. The design: everything is
a draft first, two flags let two specific kinds of post go out on their own,
and the account says it is partly automated.

## What you need from X

1. An X developer account and an app, created by you at developer.x.com, with
   **read and write** permission, using OAuth 1.0a user context. Check the
   current access tiers and prices there: posting needs write access, and
   reading your mentions needs an access level that includes reads.
2. The four values from the app's "Keys and tokens" page: API key, API key
   secret, access token, access token secret. Put them in `.env` yourself:

   ```
   X_API_KEY=...
   X_API_SECRET=...
   X_ACCESS_TOKEN=...
   X_ACCESS_SECRET=...
   ```

   `.env` is git-ignored and the kit never prints these. Regenerate them in the
   portal if they ever leak.
3. In your X settings, mark the account as automated ("Automated" label under
   "Your account", which points to the human account that runs it). X's
   automation rules require it and readers trust it more.

## Commands

```bash
npm run x -- selftest          # offline: request signing matches X's published example
npm run x -- me                # whose credentials these are
npm run x -- drafts            # the review queue
npm run x -- show <id>         # one draft in full
npm run x -- approve <id>      # approve
npm run x -- post <id>         # post an approved draft; a thread posts in order
npm run x -- reject <id> "why" # reject
npm run x -- draft "post 1" "post 2"   # add a draft by hand
npm run x -- mentions --dry-run        # list new question mentions, buy nothing
npm run x -- mentions                  # answer them from the docs and queue the replies
```

## How the three flows work

**Digest thread.** `npm run digest` already writes the thread into the digest
file. It now also saves it as a draft of kind `digest`. Review it, approve,
post. Set `X_AUTO_POST_DIGEST=1` once you trust it and the launchd or cron run
will post it unattended; the model summary is still checked by the kit against
the mechanical diff only in the sense that both are in the file, so keep
reading the file for a week before switching the flag on.

**Replies to mentions.** `npm run x -- mentions` reads mentions since the last
run, keeps the ones that look like questions, answers each from the official
docs through a FLOP miner, and saves a draft reply naming the miner in the
receipt. With `X_AUTO_REPLY=1`, replies that are grounded in a doc excerpt are
posted at once; ungrounded ones ("the docs I have do not answer that") always
wait for you. At most `X_MAX_REPLIES_PER_RUN` replies per run, five by default.
Every reply ends with "(bot, from the docs)" and carries the source link.

**Receipts and manual posts.** `npm run x -- draft "..."` queues anything you
write; the receipt block from `npm run agent -- receipt` pastes well.

## Running it on a schedule

Add the mentions check to `scripts/daily.sh`, or run it more often with its own
cron line, for example every 30 minutes:

```
*/30 * * * * cd /Users/you/flop-agent-kit && node src/x/cli.js mentions >> ~/.local/state/flop-agent-kit/x.log 2>&1
```

Each answered mention buys one small inference from a FLOP miner. That is
genuine use, which is what Flop asks for. Answering the same person in a loop
or replying to non-questions is not, and the code refuses both.

## Rules the X agent keeps

- No claims about rewards, airdrop amounts, token prices or returns, in any
  post or reply. The model's system prompt says so and you check the drafts.
- Official sources only; every reply links the page it used.
- Discloses itself: the account label, the "(bot, from the docs)" tail, and a
  pinned post that says the digest is drafted by an agent and checked by you.
- Never posts keys, signatures, seed phrases or wallet files. The queue holds
  text only.
