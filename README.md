# Goldberg Sessions

Goldberg Sessions is a Radius workshop demo for **pay-per-buffer audio streaming**. The browser only signs payments while it is filling its audio buffer; replaying cached chunks is free, and seeking beyond the buffered range resumes payment.

```
Browser MediaSource player
  -> signs EIP-712 vouchers per chunk
  -> Cloudflare Worker verifies voucher monotonicity in a Durable Object
  -> SessionEscrow settles the final voucher on Radius testnet
```

## What It Shows

- Two onchain transactions per listening session: `open` escrow and `close` settlement.
- Per-chunk EIP-712 vouchers are signed offchain and verified by the Worker before a chunk is served.
- The Worker serves the player, manifest, init segment, and gated fMP4 audio chunks.
- A Durable Object serializes session state so `cumulativeAmount` can only move forward.
- SBC uses 6 decimals; `CHUNK_PRICE = "1000"` means `0.001` SBC per chunk.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Cloudflare Worker routes for `/manifest`, `/session/*`, `/chunk/:n`, and static assets |
| `src/session-do.ts` | Durable Object that verifies vouchers and tracks latest session state |
| `src/chain.ts` | Radius testnet chain helpers, faucet relay, and `SessionEscrow.close` submission |
| `assets/index.html` | Workshop player UI with an ephemeral viem wallet and Radius transaction links |
| `assets/chunks/` | Public-domain audio encoded as an init segment plus fMP4 media chunks |
| `contracts/src/SessionEscrow.sol` | Minimal SBC session escrow contract |
| `contracts/script/Deploy.s.sol` | Foundry deployment script |

## Prerequisites

- Node.js 20+
- npm
- Cloudflare Wrangler, installed through `npm install`
- Foundry, if you want to rebuild or redeploy the escrow contract
- ffmpeg and curl, only if regenerating `assets/chunks/`

## Run Locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open `http://localhost:8787`.

By default, `wrangler.toml` is configured for the deployed Radius testnet escrow and `MOCK_CHAIN = "false"`. In that mode, set `PAYEE_PRIVATE_KEY` in `.dev.vars` so the Worker can submit `SessionEscrow.close(...)` when a session ends.

For a local-only workshop walkthrough that still exercises voucher verification but skips onchain close submission, set this in `wrangler.toml`:

```toml
MOCK_CHAIN = "true"
```

## Configuration

| Var | Purpose |
| --- | --- |
| `PAYEE_ADDRESS` | Wallet receiving settled SBC |
| `TOKEN_ADDRESS` | SBC token on Radius testnet |
| `ESCROW_ADDRESS` | Deployed `SessionEscrow` contract |
| `NETWORK` | Display/network label |
| `CHAIN_ID` | Radius testnet chain ID, `72344` |
| `CHUNK_PRICE` | Price per chunk in SBC base units |
| `CHUNK_COUNT` | Number of media chunks in `assets/chunks/` |
| `MOCK_CHAIN` | When `true`, skips onchain open/close but keeps voucher verification |
| `PAYEE_PRIVATE_KEY` | Wrangler secret used to submit `close` in real-chain mode |

Set production secrets with Wrangler:

```bash
npx wrangler secret put PAYEE_PRIVATE_KEY
```

## Rebuild Audio Chunks

The included audio is J.S. Bach's Goldberg Variations BWV 988, Aria, performed by Bradley Lehman and published as public domain through Wikimedia Commons.

```bash
npm run prepare-audio
```

The script prints the generated chunk count. If it changes, update `CHUNK_COUNT` in `wrangler.toml`.

## Deploy The Escrow Contract

```bash
cd contracts
forge install foundry-rs/forge-std --no-commit

export PRIVATE_KEY=0xYourDeployerKey
export SBC_TOKEN=0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb

forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.radiustech.xyz \
  --broadcast
```

After deployment, set `ESCROW_ADDRESS` in `wrangler.toml`.

## Checks

```bash
npm run check
cd contracts && forge build
```

`forge build` requires `contracts/lib/forge-std`, which is intentionally ignored. Install it with the command above before building contracts from a fresh checkout.
