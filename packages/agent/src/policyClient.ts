export type Reason =
  | "OK"
  | "PAUSED"
  | "ASSET_NOT_ALLOWED"
  | "OVER_TX_CAP"
  | "OVER_DAY_CAP"
  | "AGENT_KEY_INACTIVE"
  | "NO_POLICY"
  | "HCS_NOT_READY"
  | "IDENTITY_MISSING"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_AMOUNT"
  | "SOURCE_UNAVAILABLE";
export interface PolicySnapshot {
  policyExists: boolean;
  paused: boolean;
  agentKeyActive: boolean;
  hcsReady: boolean;
  identityRegistered: boolean;
  allowedTokens: string[];
  maxPerTx: bigint;
  maxPerDay: bigint;
  spentToday: bigint;
  pendingToday: bigint;
  balance: bigint;
}
export interface Decision {
  ok: boolean;
  reason: Reason;
}
export function checkPolicy(
  state: PolicySnapshot,
  asset: string,
  amount: bigint,
): Decision {
  const deny = (reason: Reason): Decision => ({ ok: false, reason });
  if (amount <= 0n) return deny("INVALID_AMOUNT");
  if (
    [
      state.maxPerTx,
      state.maxPerDay,
      state.spentToday,
      state.pendingToday,
      state.balance,
    ].some((value) => value < 0n)
  )
    return deny("SOURCE_UNAVAILABLE");
  if (!state.policyExists) return deny("NO_POLICY");
  if (!state.hcsReady) return deny("HCS_NOT_READY");
  if (!state.identityRegistered) return deny("IDENTITY_MISSING");
  if (!state.agentKeyActive) return deny("AGENT_KEY_INACTIVE");
  if (state.paused) return deny("PAUSED");
  if (!state.allowedTokens.includes(asset)) return deny("ASSET_NOT_ALLOWED");
  if (amount > state.maxPerTx) return deny("OVER_TX_CAP");
  if (amount + state.spentToday + state.pendingToday > state.maxPerDay)
    return deny("OVER_DAY_CAP");
  if (amount > state.balance) return deny("INSUFFICIENT_BALANCE");
  return { ok: true, reason: "OK" };
}

/** Read immediately before signing. Production callers must serialize and reserve pending spend. */
export async function guardedSign<T>(
  read: () => Promise<PolicySnapshot>,
  asset: string,
  amount: bigint,
  sign: () => Promise<T>,
): Promise<T> {
  let snapshot: PolicySnapshot;
  try {
    snapshot = await read();
  } catch {
    throw new Error("SOURCE_UNAVAILABLE");
  }
  const decision = checkPolicy(snapshot, asset, amount);
  if (!decision.ok) throw new Error(decision.reason);
  return sign();
}
