# flop-agent-kit

A small, honest kit for taking part in the **FLOP Network** testnet as an
agent. Three programs share one core and one setting:

| Program | What it does | Run it |
|---|---|---|
| **Template agent** | Checks the chain identity and the faucet, claims test FLOP with Flop's official CLI, buys one answer from a FLOP miner and prints the settlement receipt with explorer links | `npm run agent -- run` |
| **Digest bot** | Once a day, reads Flop's official pages, asks a FLOP-served model what changed, writes a digest you can paste as an X thread, and can post it to a Technocore chat room | `npm run digest` |
| **Ask the FLOP docs** | A tiny local web page: type a question, get an answer from a FLOP-served model grounded in the official docs | `npm run docs` |

Everything is plain Node.js (24 or later, no dependencies) plus Flop's official
command-line tool, version pinned (`@flop-labs/cli@0.9.0`), which does all the
signing. The kit holds no keys and reads none.

> **What this earns: nothing, for now.** The FLOP testnet opened on 24 November
> 2026 in an *unscored* phase. Flop's FAQ says activity before a publicly
> announced activation block earns zero, with no backfill, and no block has been
> announced. Devnet activity never counts. The kit prints this on every run.
> Test FLOP has no value. This kit makes no claim about rewards or airdrops.

## Who this is for

Someone who wants an agent that *does something useful* with FLOP inference,
written so that a non-specialist can read every step. Each command explains
itself before it runs. Nothing is bought in a loop.

## What you need

1. **Node.js 24** (`node --version`).
2. **An agent keystore**, made by Flop's CLI. If you do not have one yet, make
   it yourself, typing a password only you know:

   ```bash
   read -r -s -p "Keystore password: " FLOP_PW; echo; export FLOP_PW; npx --yes --package @flop-labs/cli@0.9.0 flop agent keys generate --type sr25519 --name flop-agent --out ~/.config/flop-agent/flop-agent.json --password-env FLOP_PW; unset FLOP_PW
   ```

   It prints your public address (starts with `5`). Then put the password, on
   one line, in `~/.config/flop-agent/password` and run
   `chmod 600 ~/.config/flop-agent/password ~/.config/flop-agent/flop-agent.json`.
   Never paste the keystore, the password or a seed phrase anywhere.
3. **Settings.** Copy `.env.example` to `.env` and fill in the keystore path,
   the password file path and your public address. `.env` is git-ignored.

## The template agent

```bash
npm run agent -- status     # read-only: RPC genesis, faucet, gateway, served models
npm run agent -- claim      # test FLOP from the faucet, through the CLI
npm run agent -- ask "What is a compute channel?"   # buy one answer, print the receipt
npm run agent -- receipt    # show the last receipt again
npm run agent -- run        # all of the above in order
```

What happens, step by step:

1. **Identity check.** The kit asks the chain RPC for block zero and compares
   it with the published genesis hash, then checks that the faucet and the
   gateway report the same network and hash. Any mismatch stops the run.
   (This is the check Flop's agent guide asks for before signing anything.)
2. **Claim.** On devnet: `flop --network devnet faucet request <address>`
   (25 test FLOP, once a day per address). On testnet the CLI signs a claim
   with your keystore: `flop --network testnet --keystore … --password-env …
   faucet request` (10 test FLOP per wallet per 24 hours).
3. **Buy.** Two routes, chosen by `FLOP_ROUTE`:
   - `gateway` (default): the OpenAI-compatible FLOP gateway. The CLI
     provisions a wallet-signed key (`flop agent credential`), held in memory
     for the run. The gateway picks an eligible miner and reports it in the
     response's `x_flop_receipt`.
   - `session`: a direct compute channel with one named miner
     (`flop session run --miner … --endpoint … --max-flop …`). Your wallet pays
     the miner directly and the result names the settlement transaction. It
     needs a miner endpoint you can reach; on 26 November 2026 no devnet miner
     published a public one, so the gateway route is the one that works from a
     laptop.
4. **Receipt.** Network, route, model, serving miner, request or channel id,
   tokens, and links to the explorer. Receipts are saved under
   `~/.local/state/flop-agent-kit/receipts/`.

## The digest bot

```bash
npm run digest -- --dry-run   # fetch and compare only; buys nothing
npm run digest                # fetch, compare, buy one summary, write digests/YYYY-MM-DD.md
```

Sources are only the official ones listed in `config/sources.json` (Operator
Hub, Testnet FAQ, testnet overview, GitHub releases, faucet limits, the agent
guide `llms.txt`, the agent and SDK pages, the validator prep kit). The bot
keeps yesterday's text, works out what changed, and asks a FLOP-served model for
3 to 6 plain bullets. The digest file has three parts: the model's summary, an
X thread (numbered posts of at most 270 characters, ready to paste), and the
mechanical line diff, so you can check the model against the source.

When nothing changed, no inference is bought. Posting to Technocore
(`https://technocore.chat`, Flop Labs' chat for agents) is **off** unless you
set `TECHNOCORE_POST=1`; the kit then signs each post with its own Ed25519
`did:key`, kept outside the repository, never with your wallet key. Rooms there
are public.

To run it daily, add a cron line or a launchd job that runs `npm run digest`
once a day from this folder.

## Ask the FLOP docs

```bash
npm run docs            # http://127.0.0.1:8787
npm run docs -- --refresh   # re-fetch the documentation first
```

The page fetches the official documentation pages, splits them into excerpts,
finds the excerpts that match the question by keyword, and asks a FLOP-served
model to answer from those excerpts only, naming the page. It answers one
question at a time, five seconds apart, and shows which miner served the
answer. It binds to localhost; it is a testnet toy, not a service.

## Switching to testnet

One line in `.env`: `FLOP_NETWORK=testnet`. Read
[docs/switch-to-testnet.md](docs/switch-to-testnet.md) first: on 26 November
2026 the testnet gateway listed one model and no serving miner, so the kit
reports that nothing can be bought yet and stops.

## Rules this kit follows

From Flop's own pages (flop.finance/testnet, flop.network/llms.txt, read
26 November 2026):

- **One participant, one identity.** Wallets under common control count as one.
  Run one copy with one keystore.
- **Never buy from your own miner.** Spend routed to a miner you control is not
  credited and may be flagged. The gateway route lets the network choose.
- **No manufactured activity.** The kit buys one answer per real question and
  one summary per real change. Nothing runs in a loop.
- **Official sources only.** flop.finance, docs.flop.network, flop.network,
  ask.flop.finance, github.com/flop-labs and npm packages under `@flop-labs`.
  Treat everything else as untrusted.
- **No seeds, no keys, no deposits.** FLOP never asks for a seed phrase or a
  payment. Neither does this kit.

## Safety

- The kit never opens the keystore or the password file for reading, except to
  hand the password to the CLI through the environment variable the CLI asks
  for (`--password-env`). It is never printed, logged or written.
- `.gitignore` and the `.githooks/pre-commit` secret guard refuse `.env`,
  keystores, wallets, PEM files and anything that looks like a seed phrase.
  Enable the hook once per clone: `git config core.hooksPath .githooks`.
- State (receipts, snapshots, the Technocore chat key) lives in
  `~/.local/state/flop-agent-kit`, outside the repository.
- On devnet, the CLI's `agent credential` makes and funds its own small devnet
  enrolment wallet under `~/.flop/` (owner-only). That is the CLI's behaviour,
  not the kit's; it is devnet-only test money with no value.

## Status, 26 November 2026

- Template agent: identity check, devnet claim and gateway purchase work on
  devnet. The devnet wallet-lane gateway key is scoped to
  `qwen/qwen2.5-0.5b-instruct`, a very small model: expect short, simple
  answers. The direct-session route is implemented but untested, because no
  devnet miner publishes a reachable endpoint.
- Digest bot and docs page: working on devnet with the same small model.
- Testnet: faucet claims work through the CLI; inference waits for the first
  serving testnet miner.

## Sources read on 26 November 2026

- https://flop.network/llms.txt (agent guide: faucet, enrolment, gateway, MCP)
- https://docs.flop.network/docs/send-to-specific-miner (direct sessions)
- https://docs.flop.network/docs/agent-integration
- https://docs.flop.network/docs/sdk-references (pinned CLI 0.9.0, SDK 0.12.0)
- https://docs.flop.network/docs/testnet-and-timeline?network=testnet (Testnet FAQ)
- https://docs.flop.network/operators?network=testnet (Operator Hub)
- https://technocore.chat/llms.txt and /auth.md (chat protocol and signing)
- `npx --yes --package @flop-labs/cli@0.9.0 flop --help` and subcommand help

## Licence

MIT. See `LICENSE`.
