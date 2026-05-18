/**
 * audio-stream-x402 Worker — MPP session-voucher edition.
 *
 * Two-tx settlement model (vs. the previous x402-per-chunk approach):
 *   1. Client opens an onchain escrow (`SessionEscrow.open`) via permit  -> 1 tx
 *   2. For each chunk, client signs an EIP-712 Voucher offchain. Worker verifies
 *      locally in the SessionDO. No RPC. Microsecond settlement.
 *   3. On session close, payee submits the final voucher onchain          -> 1 tx
 *
 * Routes:
 *   POST /session/open           { sessionId, payer, deposited, chainId } -> ack
 *                                (When MOCK_CHAIN=false, the client must
 *                                 separately broadcast the open() tx; this
 *                                 endpoint just registers the session.)
 *   GET  /chunk/:n               header X-VOUCHER: base64({sessionId, cumulativeAmount, nonce, signature})
 *   POST /session/:id/close      -> { finalVoucher } payee submits onchain
 *   GET  /session/:id            -> debugging: current state
 *
 *   GET  /manifest, /, /init.mp4 -> unchanged
 */

export { SessionDO } from "./session-do";
import { dripSbc, submitClose } from "./chain";
import type { Hex } from "viem";

export interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  PAYEE_ADDRESS: string;
  TOKEN_ADDRESS: string;
  ESCROW_ADDRESS: string;
  NETWORK: string;
  CHAIN_ID: string;
  CHUNK_PRICE: string;
  CHUNK_COUNT: string;
  MOCK_CHAIN?: string;
  PAYEE_PRIVATE_KEY?: string;
}

function doFor(env: Env, sessionId: string) {
  const id = env.SESSIONS.idFromName(sessionId);
  return env.SESSIONS.get(id);
}

async function callDO(env: Env, sessionId: string, op: string, body?: unknown) {
  return doFor(env, sessionId).fetch(`https://do/${op}`, {
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "content-type": "application/json" } : undefined,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- static + manifest ----
    if (url.pathname === "/manifest") {
      const count = Number(env.CHUNK_COUNT);
      return Response.json({
        chunks: Array.from({ length: count }, (_, i) => `/chunk/${i}`),
        initSegment: "/init.mp4",
        codec: 'audio/mp4; codecs="mp4a.40.2"',
        pricePerChunkBaseUnits: env.CHUNK_PRICE,
        payee: env.PAYEE_ADDRESS,
        token: env.TOKEN_ADDRESS,
        escrow: env.ESCROW_ADDRESS,
        network: env.NETWORK,
        chainId: Number(env.CHAIN_ID),
        mockChain: env.MOCK_CHAIN === "true",
      });
    }
    if (url.pathname === "/init.mp4") {
      return env.ASSETS.fetch(new Request(new URL("/chunks/init.mp4", url)));
    }

    // ---- session lifecycle ----
    if (url.pathname === "/session/fund" && req.method === "POST") {
      const { address } = (await req.json()) as { address: string };
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return Response.json({ ok: false, error: "bad address" }, { status: 400 });
      }
      try {
        const result = await dripSbc(address);
        return Response.json(result);
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 502 });
      }
    }

    if (url.pathname === "/session/open" && req.method === "POST") {
      const body = (await req.json()) as {
        sessionId: string;
        payer: string;
        deposited: string;
        expirySeconds: number;
      };
      const meta = {
        sessionId: body.sessionId,
        payer: body.payer,
        payee: env.PAYEE_ADDRESS,
        deposited: body.deposited,
        expiry: Math.floor(Date.now() / 1000) + body.expirySeconds,
        chainId: Number(env.CHAIN_ID),
        escrow: env.ESCROW_ADDRESS,
        opened: Date.now(),
        closed: false,
      };
      const r = await callDO(env, body.sessionId, "init", meta);
      if (!r.ok) return r;

      // In MOCK_CHAIN=false mode, the client must have already broadcast
      // SessionEscrow.open(...) onchain; we could verify by reading logs here.
      // For the PoC we trust the client's reported deposit and let close()
      // be the moment the chain matters.
      return Response.json({ ok: true, meta });
    }

    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(?:\/(close|state))?$/);
    if (sessionMatch) {
      const sid = sessionMatch[1];
      const op = sessionMatch[2] ?? "state";
      if (op === "close" && env.MOCK_CHAIN !== "true" && !env.PAYEE_PRIVATE_KEY) {
        return Response.json(
          {
            ok: false,
            error:
              "PAYEE_PRIVATE_KEY secret is required to close a real-chain session. Set MOCK_CHAIN=true for local-only demos.",
          },
          { status: 500 },
        );
      }
      const r = await callDO(env, sid, op, op === "close" ? {} : undefined);

      // If closing in real-chain mode, submit close() onchain with the final voucher.
      if (op === "close" && env.MOCK_CHAIN !== "true" && env.PAYEE_PRIVATE_KEY) {
        try {
          const body = (await r.clone().json()) as {
            ok: boolean;
            finalVoucher?: { cumulativeAmount: string; nonce: number; signature: Hex };
          };
          if (body.finalVoucher) {
            const txHash = await submitClose(
              env.PAYEE_PRIVATE_KEY as Hex,
              env.ESCROW_ADDRESS as `0x${string}`,
              sid as `0x${string}`,
              BigInt(body.finalVoucher.cumulativeAmount),
              BigInt(body.finalVoucher.nonce),
              body.finalVoucher.signature,
            );
            return Response.json({ ...body, closeTxHash: txHash });
          }
        } catch (e) {
          return Response.json(
            { ok: false, error: `close submission failed: ${String(e)}` },
            { status: 500 },
          );
        }
      }
      return r;
    }

    // ---- chunk delivery (voucher-gated) ----
    const chunkMatch = url.pathname.match(/^\/chunk\/(\d+)$/);
    if (chunkMatch) {
      const n = Number(chunkMatch[1]);
      const max = Number(env.CHUNK_COUNT);
      if (n < 0 || n >= max) return new Response("not found", { status: 404 });

      const voucherHeader = req.headers.get("x-voucher");
      if (!voucherHeader) {
        return Response.json(
          {
            error: "no voucher",
            hint: "POST /session/open first, then send X-VOUCHER: base64({sessionId, cumulativeAmount, nonce, signature})",
          },
          { status: 402 },
        );
      }

      let v: {
        sessionId: string;
        cumulativeAmount: string;
        nonce: number;
        signature: `0x${string}`;
      };
      try {
        v = JSON.parse(atob(voucherHeader));
      } catch {
        return new Response("bad voucher header", { status: 400 });
      }

      const redeemRes = await callDO(env, v.sessionId, "redeem", {
        chunkIndex: v.nonce,
        cumulativeAmount: v.cumulativeAmount,
        signature: v.signature,
      });
      if (!redeemRes.ok) {
        const body = await redeemRes.text();
        return new Response(body, {
          status: redeemRes.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Voucher valid + monotonic → stream the chunk.
      const chunkUrl = new URL(`/chunks/chunk-${String(n + 1).padStart(4, "0")}.m4s`, url);
      const assetRes = await env.ASSETS.fetch(new Request(chunkUrl));
      if (!assetRes.ok) return new Response("chunk missing", { status: 404 });

      const headers = new Headers(assetRes.headers);
      headers.set("content-type", "audio/mp4");
      headers.set("x-voucher-accepted", v.cumulativeAmount);
      headers.set("access-control-expose-headers", "x-voucher-accepted");
      return new Response(assetRes.body, { status: 200, headers });
    }

    return env.ASSETS.fetch(req);
  },
};
