import { describe, expect, it, vi } from "vitest";
import {
  checkPolicy,
  guardedSign,
  type PolicySnapshot,
} from "../packages/agent/src/policyClient";
import { demoPolicy, createApp } from "../packages/server/src/app";
describe("agent policy boundary", () => {
  it.each([
    [{ paused: true }, "PAUSED"],
    [{ agentKeyActive: false }, "AGENT_KEY_INACTIVE"],
    [{ hcsReady: false }, "HCS_NOT_READY"],
    [{ identityRegistered: false }, "IDENTITY_MISSING"],
    [{ policyExists: false }, "NO_POLICY"],
    [{ allowedTokens: [] }, "ASSET_NOT_ALLOWED"],
    [{ maxPerTx: 0n }, "OVER_TX_CAP"],
    [{ spentToday: 4_999_999n }, "OVER_DAY_CAP"],
    [{ pendingToday: 3_800_000n }, "OVER_DAY_CAP"],
    [{ balance: 0n }, "INSUFFICIENT_BALANCE"],
    [{ pendingToday: -1n }, "SOURCE_UNAVAILABLE"],
  ] as [Partial<PolicySnapshot>, string][])(
    "never signs for denied snapshot %#",
    async (override, reason) => {
      const sign = vi.fn();
      await expect(
        guardedSign(
          async () => ({ ...demoPolicy, ...override }),
          "0.0.429274",
          10n,
          sign,
        ),
      ).rejects.toThrow(reason);
      expect(sign).not.toHaveBeenCalled();
    },
  );
  it("fails closed on unavailable sources", async () => {
    const sign = vi.fn();
    await expect(
      guardedSign(
        async () => {
          throw new Error("mirror timeout");
        },
        "0.0.429274",
        10n,
        sign,
      ),
    ).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(sign).not.toHaveBeenCalled();
  });
  it("allows exact cap, rejects zero, negative and cap+1", () => {
    expect(checkPolicy(demoPolicy, "0.0.429274", 1_000_000n).ok).toBe(true);
    for (const amount of [0n, -1n, 1_000_001n])
      expect(checkPolicy(demoPolicy, "0.0.429274", amount).ok).toBe(false);
  });
  it("does not silently allow HBAR", () => {
    expect(checkPolicy(demoPolicy, "0.0.0", 1n).reason).toBe(
      "ASSET_NOT_ALLOWED",
    );
  });
  it("returns the result from an allowed signer exactly once", async () => {
    const sign = vi.fn(async () => "signature");
    expect(
      await guardedSign(async () => demoPolicy, "0.0.429274", 1n, sign),
    ).toBe("signature");
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
describe("API", () => {
  const app = createApp();
  it("reports local readiness truthfully", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "demo",
      liveAdaptersReady: false,
    });
  });
  it("refuses to charge before identity and payment adapters exist", async () => {
    const response = await app.request("/standing/0.0.123");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ paymentRequired: false });
    expect(response.headers.has("PAYMENT-REQUIRED")).toBe(false);
  });
  it.each(["-1", "1.5", "1e6", "", "9".repeat(31)])(
    "rejects malformed or oversized amount %s",
    async (amount) => {
      const response = await app.request("/demo/policy/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          asset: "0.0.429274",
          paused: false,
          agentKeyActive: true,
        }),
      });
      expect(response.status).toBe(400);
    },
  );
  it("demo revocation denies preview", async () => {
    const response = await app.request("/demo/policy/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: "10",
        asset: "0.0.429274",
        paused: false,
        agentKeyActive: false,
      }),
    });
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "AGENT_KEY_INACTIVE",
      transactionSubmitted: false,
    });
  });
  it("disables synthetic policy endpoints outside demo mode", async () => {
    expect(
      (
        await createApp("testnet").request("/demo/policy/preview", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });
});
