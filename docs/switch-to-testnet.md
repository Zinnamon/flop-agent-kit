# Switching the kit from devnet to testnet

One line does it. In `.env`:

```
FLOP_NETWORK=testnet
```

Every program reads that setting: the template agent, the digest bot and the
docs page then use the testnet RPC (`https://testnet.flop.network`), the testnet
faucet (`https://faucet.flop.network`), the testnet gateway
(`https://gateway.testnet.flop.network`) and the testnet explorer
(`https://testnet.flopscan.io`), with the testnet genesis hash
`0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800` checked
against block zero before anything is signed.

## What changes on testnet, and what to check first

Run the read-only check and read its output:

```bash
npm run agent -- status
```

- **Claim.** On testnet the faucet pays 10 test FLOP per wallet per rolling
  24 hours to a signed agent claim. The CLI signs it from your keystore
  (`flop --network testnet --keystore … --password-env … faucet request`).
  The next grant comes only after the previous one was spent on chain
  (`rolloverRequiresSpend`). A refusal is normal when the faucet is low or the
  24 hours have not passed. Never retry a refusal in a loop.
- **Buy.** `status` lists the models the testnet gateway serves and how many
  miners serve each. On 26 November 2026 the gateway listed one model and no
  serving miner, so nothing could be bought. The kit stops with a clear message
  until a miner serves. When one does, the gateway route may still need a
  testnet gateway key: in CLI 0.9.0 `flop agent credential` provisions a
  **devnet** key. If the testnet gateway refuses, wait for Flop's testnet
  agent instructions (Operator Hub, `docs.flop.network/operators?network=testnet`)
  and do not improvise a signing flow.
- **Direct sessions.** If Flop publishes a testnet miner endpoint you can
  reach, set `FLOP_ROUTE=session`, `FLOP_MINER` and `FLOP_ENDPOINT`. The escrow
  `FLOP_MAX_FLOP` is the whole payment, not a cap. Keep it small.
- **What it earns.** Nothing before the publicly announced activation block,
  which had not been announced on 26 November 2026. The kit prints this on
  every run. Devnet activity never counts and does not carry over.

## Rules the kit keeps on both networks

- One participant, one agent identity. Do not run copies of the kit with
  different wallets; Flop scores wallets under common control as one
  participant and treats manufactured activity as forfeit.
- Never buy from a miner you control. The kit lets the gateway choose the
  miner; the direct-session route needs an explicit `FLOP_MINER`, so never set
  it to your own.
- Spend only what the programs genuinely use: one answer per question, one
  summary per digest, nothing in a loop.
- Keys stay out of this repository and out of chat. The kit never reads the
  keystore or the password itself.
