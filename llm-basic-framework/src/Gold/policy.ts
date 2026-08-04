import { compactVerdict, rowKey, type PairAnnotation } from './llmAnnotate';
import type { PropagationConflict } from './propagate';
import type { WorksheetRow } from './worksheet';

/**
 * Policy induction: turn the human's adjudicated rows into few-shot exemplars, have one strong
 * model infer the decision rules behind them, and apply those rules to what is left — the
 * unlabelled tail and the machine prefills the closure exposed as contradictory.
 *
 * The point, versus another round of plain ensemble labelling: the ensemble judged pairs under
 * the generic instructions, before the human's policy existed. Sixty-odd human verdicts encode
 * corpus-specific refinements (how Ukrainian inflections fold, when a national scope qualifier
 * is a rung, what `органи` vs `організації` means) that no generic prompt carries. Exemplar
 * induction is the cheapest faithful way to reuse them at scale — and the model must *state* the
 * rules it inferred, so the induction itself is auditable (`gold/policy-inferred.md`).
 *
 * A policy verdict is still a machine conclusion: rows land as `agreement: 'policy'` in the
 * confirm tier, never as final.
 */

const machinePrefill = (row: WorksheetRow): boolean => {
  const rulePrefill = row.suggested !== 'review' && row.label === row.suggested;
  const ensemblePrefill =
    row.label !== '' && row.ensemble !== undefined && row.label === row.ensemble.split(':')[0];
  return rulePrefill || ensemblePrefill;
};

/** The human's verdicts: labels that deviate from every machine prefill and are not themselves derived. */
export function humanExemplars(rows: WorksheetRow[]): WorksheetRow[] {
  return rows.filter(
    (row) =>
      row.label !== '' &&
      !machinePrefill(row) &&
      row.agreement !== 'derived' &&
      row.agreement !== 'policy'
  );
}

/** One exemplar per line, the shape the gold-policy-label prompt's {{examples}} slot expects. */
export function renderExemplars(rows: WorksheetRow[]): string {
  return rows
    .map((row) => {
      const compact = [row.label, row.relation, row.direction].filter(Boolean).join(':');
      return `${row.category} | ${row.left} | ${row.right} => ${compact}`;
    })
    .join('\n');
}

/**
 * What the policy judge re-decides: unlabelled rows, plus machine-labelled rows the closure
 * flagged as contradictory — those prefills were made without the human's policy, and the
 * contradiction is the evidence. Human and derived rows are never targets.
 */
export function selectPolicyTargets(
  rows: WorksheetRow[],
  conflicts: PropagationConflict[]
): WorksheetRow[] {
  const conflicted = new Set<string>();
  for (const conflict of conflicts) {
    for (const row of conflict.rows) conflicted.add(rowKey(row));
  }
  return rows.filter((row) => {
    if (row.agreement === 'human' || row.agreement === 'derived') return false;
    if (row.label === '') return true;
    return machinePrefill(row) && conflicted.has(rowKey(row));
  });
}

export interface PolicySummary {
  filled: number;
  replaced: number;
  unsure: number;
}

/**
 * Write the policy verdicts into the worksheet: fill or replace the label, mark
 * `agreement: 'policy'`, and queue for confirmation. An `unsure` vote changes nothing — the row
 * keeps whatever state routed it here.
 */
export function applyPolicyVerdicts(
  rows: WorksheetRow[],
  votes: Map<string, PairAnnotation>
): { rows: WorksheetRow[]; summary: PolicySummary } {
  const summary: PolicySummary = { filled: 0, replaced: 0, unsure: 0 };

  const out = rows.map((row) => {
    const vote = votes.get(rowKey(row));
    if (!vote) return { ...row };
    if (row.agreement === 'human' || row.agreement === 'derived') return { ...row };
    if (vote.verdict === 'unsure') {
      summary.unsure++;
      return { ...row };
    }

    if (row.label === '') summary.filled++;
    else summary.replaced++;

    return {
      ...row,
      label: vote.verdict,
      relation: vote.relation || undefined,
      direction: vote.direction || undefined,
      ensemble: compactVerdict(vote),
      agreement: 'policy',
      llmRationale: vote.rationale || row.llmRationale,
      queue: 3,
    };
  });

  out.sort(
    (a, b) =>
      (a.queue ?? 5) - (b.queue ?? 5) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
      b.sim - a.sim ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0)
  );

  return { rows: out, summary };
}
