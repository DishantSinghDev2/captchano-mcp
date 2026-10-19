/**
 * Per-process spend tracker. Sums the `cost` field (USD string) of every
 * task this process created, counting each task id at most once, and refuses
 * new solves once the configured ceiling is reached.
 *
 * Amounts are accumulated in micro-dollars (integers) to avoid floating-point
 * drift over many small charges.
 */
export class Budget {
  private spentMicros = 0;
  private readonly counted = new Set<string>();
  private readonly limitMicros: number | undefined;

  constructor(maxSpendUsd: number | undefined) {
    this.limitMicros = maxSpendUsd === undefined ? undefined : toMicros(maxSpendUsd);
  }

  get limitUsd(): number | undefined {
    return this.limitMicros === undefined ? undefined : this.limitMicros / 1_000_000;
  }

  get spentUsd(): number {
    return this.spentMicros / 1_000_000;
  }

  get remainingUsd(): number | undefined {
    if (this.limitMicros === undefined) return undefined;
    return Math.max(0, this.limitMicros - this.spentMicros) / 1_000_000;
  }

  /** True when a ceiling is configured and it has been reached. */
  get exhausted(): boolean {
    return this.limitMicros !== undefined && this.spentMicros >= this.limitMicros;
  }

  /**
   * Records the cost of a task. Ignores missing/invalid/zero costs and task ids
   * that were already counted. Returns true when the cost was added.
   */
  record(taskId: string, cost: string | number | undefined | null): boolean {
    if (cost === undefined || cost === null || cost === "") return false;
    if (this.counted.has(taskId)) return false;
    const n = typeof cost === "number" ? cost : Number(cost);
    if (!Number.isFinite(n) || n <= 0) return false;
    this.counted.add(taskId);
    this.spentMicros += toMicros(n);
    return true;
  }

  summary(): { spentUsd: string; limitUsd: string | null; remainingUsd: string | null } {
    return {
      spentUsd: formatUsd(this.spentUsd),
      limitUsd: this.limitUsd === undefined ? null : formatUsd(this.limitUsd),
      remainingUsd: this.remainingUsd === undefined ? null : formatUsd(this.remainingUsd),
    };
  }
}

function toMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function formatUsd(n: number): string {
  return n.toFixed(6).replace(/0{1,2}$/, "");
}
