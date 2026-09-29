/** Hard budget for one task (design §5.2). No policy may exceed it. */
export interface Budget {
  maxCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRemoteCalls: number;
  maxParallelAttempts: number;
  /** ISO-8601 UTC. */
  deadlineAt: string;
}

export interface Spend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  remoteCalls: number;
}

export const ZERO_SPEND: Readonly<Spend> = Object.freeze({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  remoteCalls: 0,
});

export function addSpend(a: Spend, b: Partial<Spend>): Spend {
  return {
    costUsd: round6(a.costUsd + (b.costUsd ?? 0)),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    remoteCalls: a.remoteCalls + (b.remoteCalls ?? 0),
  };
}

export function subtractSpend(a: Spend, b: Partial<Spend>): Spend {
  return {
    costUsd: Math.max(0, round6(a.costUsd - (b.costUsd ?? 0))),
    inputTokens: Math.max(0, a.inputTokens - (b.inputTokens ?? 0)),
    outputTokens: Math.max(0, a.outputTokens - (b.outputTokens ?? 0)),
    remoteCalls: Math.max(0, a.remoteCalls - (b.remoteCalls ?? 0)),
  };
}

export type BudgetDimension = 'cost' | 'input_tokens' | 'output_tokens' | 'remote_calls';

/** The first exhausted dimension of `spent` (spend plus in-flight reservations), if any. */
export function exhaustedDimension(budget: Budget, spent: Spend): BudgetDimension | undefined {
  if (spent.costUsd >= budget.maxCostUsd) return 'cost';
  if (spent.inputTokens >= budget.maxInputTokens) return 'input_tokens';
  if (spent.outputTokens >= budget.maxOutputTokens) return 'output_tokens';
  return undefined;
}

/** True when committed spend has gone past a hard limit: must never happen, and is alarmed on. */
export function isOverBudget(budget: Budget, spent: Spend): boolean {
  return (
    spent.costUsd > budget.maxCostUsd + 1e-9 ||
    spent.inputTokens > budget.maxInputTokens ||
    spent.outputTokens > budget.maxOutputTokens ||
    spent.remoteCalls > budget.maxRemoteCalls
  );
}

export interface SpendEstimate {
  costUsd: number;
  remoteCalls: number;
}

/**
 * Admission check for a new action: committed spend + in-flight reservations + the
 * action's own estimate must fit. Reservations are what make the budget *hard*:
 * parallel attempts cannot each individually pass the check and jointly overshoot.
 */
export function affordability(
  budget: Budget,
  committed: Spend,
  reserved: Spend,
  estimate: SpendEstimate,
): { ok: true } | { ok: false; dimension: BudgetDimension } {
  const projected = addSpend(addSpend(committed, reserved), estimate);
  if (projected.costUsd > budget.maxCostUsd + 1e-9) return { ok: false, dimension: 'cost' };
  if (projected.remoteCalls > budget.maxRemoteCalls) return { ok: false, dimension: 'remote_calls' };
  const exhausted = exhaustedDimension(budget, addSpend(committed, reserved));
  if (exhausted !== undefined) return { ok: false, dimension: exhausted };
  return { ok: true };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
