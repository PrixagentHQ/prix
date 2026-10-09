/**
 * The arithmetic of the weight rows of a paper manager, in plain code that follows the contract's
 * limits (MANAGER_* in packages/contracts/src/phase6-social.ts). The limits arrive as numbers from the
 * server, so a browser script does not import the schema library.
 *
 * This only saves the person a round trip and shows the cash that the weights leave. The API
 * checks every request again and decides: eligibility, slots, the allocation in force.
 */

export interface WeightLimits {
  minAgents: number;
  maxAgents: number;
  /** Basis points. */
  minWeightBps: number;
  maxWeightBps: number;
}

export interface WeightRow {
  /** The agent chosen, or an empty string. */
  id: string;
  /** What was typed in the weight field, in percent. */
  percent: string;
}

/** A percent typed with up to two decimals, as whole basis points, or null when it is not a number of that form. */
export function percentToBps(value: string): number | null {
  const typed = value.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(typed)) return null;
  return Math.round(Number(typed) * 100);
}

/** Basis points as a percent without trailing zeros: 1250 is "12.5", 3000 is "30". */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return String(whole);
  const decimals = String(rest).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${decimals}`;
}

export interface Allocation {
  /** The weights that parsed, in basis points. */
  sumBps: number;
  /** What the weights leave: negative when they add up to more than 100%. */
  cashBps: number;
}

/** The sum of the weights typed so far and the cash they leave. A weight that does not parse counts as nothing. */
export function allocationOf(rows: readonly WeightRow[]): Allocation {
  const sumBps = rows.reduce((total, row) => total + (percentToBps(row.percent) ?? 0), 0);
  return { sumBps, cashBps: 10_000 - sumBps };
}

export type RowIssue = 'agent_missing' | 'agent_twice' | 'weight_missing' | 'weight_range';
export type AllocationIssue = 'count' | 'over';

export interface Check {
  /** The first issue of each row, or null. */
  rows: Array<RowIssue | null>;
  /** An issue of the allocation as a whole, or null. */
  whole: AllocationIssue | null;
  ok: boolean;
}

export function checkRows(rows: readonly WeightRow[], limits: WeightLimits): Check {
  const seen = new Set<string>();
  const issues = rows.map((row): RowIssue | null => {
    if (row.id === '') return 'agent_missing';
    const bps = percentToBps(row.percent);
    if (bps === null) return 'weight_missing';
    if (bps < limits.minWeightBps || bps > limits.maxWeightBps) return 'weight_range';
    if (seen.has(row.id)) return 'agent_twice';
    seen.add(row.id);
    return null;
  });
  const whole: AllocationIssue | null =
    rows.length < limits.minAgents || rows.length > limits.maxAgents
      ? 'count'
      : allocationOf(rows).sumBps > 10_000
        ? 'over'
        : null;
  return { rows: issues, whole, ok: whole === null && issues.every((issue) => issue === null) };
}

/** The request body for the rows, once they pass: agent id to basis points. */
export function targetsOf(rows: readonly WeightRow[]): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const row of rows) {
    const bps = percentToBps(row.percent);
    if (row.id !== '' && bps !== null) targets[row.id] = bps;
  }
  return targets;
}
