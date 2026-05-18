/**
 * Server-side chain interactions for SessionEscrow.
 * The Worker uses these to:
 *   - Relay faucet drips to the browser-side ephemeral wallet (CORS-safe)
 *   - Submit SessionEscrow.close(finalVoucher) on session end (payee-only)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const radiusTestnet = defineChain({
  id: 72344,
  name: "Radius Testnet",
  nativeCurrency: { decimals: 18, name: "RUSD", symbol: "RUSD" },
  rpcUrls: { default: { http: ["https://rpc.testnet.radiustech.xyz"] } },
  blockExplorers: {
    default: { name: "Radius Explorer", url: "https://testnet.radiustech.xyz" },
  },
});

const ESCROW_ABI = parseAbi([
  "function close(bytes32 sessionId, uint256 cumulativeAmount, uint256 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function sessions(bytes32) view returns (address payer, address payee, uint128 deposited, uint128 spent, uint64 expiry, bool closed)",
]);

export function publicClient() {
  return createPublicClient({ chain: radiusTestnet, transport: http() });
}

export function payeeWallet(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    client: createWalletClient({ account, chain: radiusTestnet, transport: http() }),
  };
}

const FAUCET_URL = "https://testnet.radiustech.xyz/api/v1/faucet/drip";

export async function dripSbc(address: string) {
  const r = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, token: "SBC" }),
  });
  return (await r.json()) as
    | { success: true; tx_hash: string; amount: string; next_drip_at: number }
    | { success: false; error: unknown };
}

export async function submitClose(
  payeePk: Hex,
  escrow: `0x${string}`,
  sessionId: `0x${string}`,
  cumulativeAmount: bigint,
  nonce: bigint,
  signature: Hex,
) {
  const { client } = payeeWallet(payeePk);
  // split sig into v,r,s
  const r = signature.slice(0, 66) as Hex;
  const s = ("0x" + signature.slice(66, 130)) as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  const hash = await client.writeContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "close",
    args: [sessionId, cumulativeAmount, nonce, v, r, s],
  });
  return hash;
}
