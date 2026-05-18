/// <reference types="@cloudflare/workers-types" />
/**
 * SessionDO — Durable Object holding the per-session voucher state.
 *
 * Why a DO: voucher monotonicity (`cumulativeAmount` only goes up) and a known
 * `latestVoucher` field both require single-writer state. KV is read-your-writes
 * eventual; DOs serialize requests for a given key.
 *
 * State (in DO storage):
 *   meta:           { sessionId, payer, payee, deposited, expiry, chainId, escrow, opened, closed }
 *   latestVoucher:  { cumulativeAmount, nonce, signature }   // monotonic
 *   chunksServed:   Set<number>                              // for replay protection / UI
 */

import { verifyTypedData, getAddress, type Hex } from "viem";

type SessionMeta = {
  sessionId: `0x${string}`;
  payer: `0x${string}`;
  payee: `0x${string}`;
  deposited: string; // bigint as decimal string
  expiry: number;
  chainId: number;
  escrow: `0x${string}`;
  opened: number;
  closed: boolean;
};

type Voucher = {
  cumulativeAmount: string;
  nonce: number;
  signature: Hex;
};

const VOUCHER_TYPES = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export class SessionDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const op = url.pathname.split("/").pop();

    if (op === "init") {
      const body = (await req.json()) as SessionMeta;
      await this.state.storage.put("meta", body);
      await this.state.storage.put("chunksServed", [] as number[]);
      return Response.json({ ok: true });
    }

    if (op === "redeem") {
      // Body: { chunkIndex, cumulativeAmount, signature }
      const { chunkIndex, cumulativeAmount, signature } = (await req.json()) as {
        chunkIndex: number;
        cumulativeAmount: string;
        signature: Hex;
      };
      const meta = (await this.state.storage.get<SessionMeta>("meta")) || null;
      if (!meta) return Response.json({ ok: false, reason: "no session" }, { status: 404 });
      if (meta.closed) return Response.json({ ok: false, reason: "closed" }, { status: 410 });
      if (Date.now() / 1000 > meta.expiry)
        return Response.json({ ok: false, reason: "expired" }, { status: 410 });

      const latest = (await this.state.storage.get<Voucher>("latestVoucher")) || null;
      const cum = BigInt(cumulativeAmount);
      const prev = latest ? BigInt(latest.cumulativeAmount) : 0n;
      if (cum <= prev)
        return Response.json({ ok: false, reason: "non-monotonic" }, { status: 400 });
      if (cum > BigInt(meta.deposited))
        return Response.json({ ok: false, reason: "exceeds escrow" }, { status: 402 });

      const domain = {
        name: "SessionEscrow",
        version: "1",
        chainId: meta.chainId,
        verifyingContract: getAddress(meta.escrow),
      };
      const ok = await verifyTypedData({
        address: getAddress(meta.payer),
        domain,
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: {
          sessionId: meta.sessionId,
          cumulativeAmount: cum,
          nonce: BigInt(chunkIndex),
        },
        signature,
      });
      if (!ok) return Response.json({ ok: false, reason: "bad signature" }, { status: 401 });

      const voucher: Voucher = { cumulativeAmount, nonce: chunkIndex, signature };
      await this.state.storage.put("latestVoucher", voucher);

      const served = (await this.state.storage.get<number[]>("chunksServed")) || [];
      if (!served.includes(chunkIndex)) {
        served.push(chunkIndex);
        await this.state.storage.put("chunksServed", served);
      }
      return Response.json({ ok: true, latest: voucher });
    }

    if (op === "state") {
      const meta = await this.state.storage.get<SessionMeta>("meta");
      const latest = await this.state.storage.get<Voucher>("latestVoucher");
      const served = await this.state.storage.get<number[]>("chunksServed");
      return Response.json({ meta, latest, served });
    }

    if (op === "close") {
      const meta = await this.state.storage.get<SessionMeta>("meta");
      if (!meta) return Response.json({ ok: false }, { status: 404 });
      const latest = await this.state.storage.get<Voucher>("latestVoucher");
      meta.closed = true;
      await this.state.storage.put("meta", meta);
      return Response.json({ ok: true, finalVoucher: latest, meta });
    }

    return new Response("not found", { status: 404 });
  }
}
