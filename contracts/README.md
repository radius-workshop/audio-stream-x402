# SessionEscrow

MPP-style session escrow for Radius + SBC. Two onchain transactions per session: `open` (pulls funds via EIP-2612 permit) and `close` (settles the final cumulative voucher signed offchain by the payer).

## Deploy

Install [foundry](https://book.getfoundry.sh/getting-started/installation), then:

```bash
cd contracts
forge install foundry-rs/forge-std --no-commit

export PRIVATE_KEY=0xYourDeployerKey
export SBC_TOKEN=0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb

forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.radiustech.xyz \
  --broadcast
```

Note the deployed address and set `ESCROW_ADDRESS` in `../wrangler.toml`.

## EIP-712 voucher

```
domain:  { name: "SessionEscrow", version: "1", chainId: 72344, verifyingContract: <deployed> }
types:   { Voucher: [ { name: "sessionId", type: "bytes32" },
                      { name: "cumulativeAmount", type: "uint256" },
                      { name: "nonce", type: "uint256" } ] }
```

Vouchers are monotonic: each new voucher's `cumulativeAmount` must strictly exceed the previous (the server enforces this; the contract only sees the final one). `nonce` is informational — typically the chunk index — and prevents identical-amount-replay during signing.
