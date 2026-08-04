import { UnionFind } from '../Evaluation/unionFind';
import type { WorksheetRow } from './worksheet';

/**
 * Fill unlabelled worksheet rows whose verdict is already *implied* by the adjudicated ones.
 *
 * Identity is an equivalence relation, so labels propagate mechanically: `same` closes
 * transitively; a `different` between two members separates their whole clusters; a `rung` or
 * `rename` between two members connects their whole clusters. An unlabelled pair whose endpoints
 * those closures already relate needs no annotator — human, model or otherwise — and filling it
 * by hand would only invite the inconsistencies this module instead detects.
 *
 * Derived rows are marked `agreement: 'derived'` (with the basis in `llmRationale`) and sink to
 * the done tier. They are machine conclusions *about* human/accepted labels: re-derivable, and
 * still overridable by the human like anything else in the label column.
 *
 * Contradictions — a labelled `different`/`rung`/`rename` whose endpoints a `same` chain merged,
 * or two incompatible lifted verdicts between the same clusters — are reported, never repaired.
 */

const fold = (value: string) => value.trim().toLowerCase();
const keyOf = (category: string, surface: string) => `${fold(category)}|${fold(surface)}`;

export interface PropagationConflict {
  reason: string;
  rows: WorksheetRow[];
}

export function propagateVerdicts(rows: WorksheetRow[]): {
  rows: WorksheetRow[];
  derived: number;
  conflicts: PropagationConflict[];
} {
  const out = rows.map((row) => ({ ...row }));
  const conflicts: PropagationConflict[] = [];
  let derived = 0;

  // Iterate to a fixpoint: a derived `same` merges clusters, which can imply further verdicts.
  for (let pass = 0; pass < 10; pass++) {
    const union = new UnionFind<string>();
    for (const row of out) {
      if (row.label !== 'same') continue;
      union.union(keyOf(row.category, row.left), keyOf(row.category, row.right));
    }
    const clusterOf = (category: string, surface: string): string => {
      const key = keyOf(category, surface);
      return union.has(key) ? String(union.find(key)) : key;
    };

    // Lift non-merging labelled verdicts to cluster level.
    const pairKey = (a: string, b: string) => (a < b ? `${a}##${b}` : `${b}##${a}`);
    const separated = new Map<string, WorksheetRow>();
    /** finerCluster -> coarserCluster, with the verdict that asserted it. */
    const connected = new Map<string, { row: WorksheetRow; label: string; relation: string }>();

    for (const row of out) {
      if (row.label !== 'different' && row.label !== 'rung' && row.label !== 'rename') continue;
      const a = clusterOf(row.category, row.left);
      const b = clusterOf(row.category, row.right);
      if (a === b) {
        conflicts.push({
          reason: `${row.label} verdict inside one same-cluster: ${row.category}: "${row.left}" vs "${row.right}"`,
          rows: [row],
        });
        continue;
      }
      if (row.label === 'different') {
        separated.set(pairKey(a, b), row);
      } else {
        const finer = row.direction === 'left' ? a : b;
        const coarser = row.direction === 'left' ? b : a;
        connected.set(`${finer}=>${coarser}`, { row, label: row.label, relation: row.relation ?? '' });
      }
    }

    let filledThisPass = 0;
    for (const row of out) {
      if (row.label !== '') continue;
      const a = clusterOf(row.category, row.left);
      const b = clusterOf(row.category, row.right);

      const sameImplied = a === b;
      const diffBasis = separated.get(pairKey(a, b));
      const rungForward = connected.get(`${a}=>${b}`); // left side finer
      const rungBackward = connected.get(`${b}=>${a}`); // right side finer
      const implications =
        Number(sameImplied) + Number(diffBasis !== undefined) + Number(rungForward !== undefined || rungBackward !== undefined);

      if (implications === 0) continue;
      if (implications > 1) {
        conflicts.push({
          reason: `contradictory implications for ${row.category}: "${row.left}" vs "${row.right}"`,
          rows: [row],
        });
        continue;
      }

      if (sameImplied) {
        row.label = 'same';
        row.llmRationale = 'derived: endpoints already connected by adjudicated same-verdicts';
      } else if (diffBasis) {
        row.label = 'different';
        row.llmRationale = `derived: separated via "${diffBasis.left}" ≠ "${diffBasis.right}"`;
      } else {
        const basis = (rungForward ?? rungBackward)!;
        row.label = basis.label;
        row.relation = basis.relation || undefined;
        row.direction = rungForward ? 'left' : 'right';
        row.llmRationale = `derived: ${basis.label} via "${basis.row.left}" / "${basis.row.right}"`;
      }
      row.agreement = 'derived';
      row.queue = 5;
      filledThisPass++;
      derived++;
    }

    if (filledThisPass === 0) break;
  }

  out.sort(
    (a, b) =>
      (a.queue ?? 5) - (b.queue ?? 5) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
      b.sim - a.sim ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0)
  );

  // The same contradiction can be rediscovered on every pass — report each once.
  const seen = new Set<string>();
  const uniqueConflicts = conflicts.filter((conflict) => {
    if (seen.has(conflict.reason)) return false;
    seen.add(conflict.reason);
    return true;
  });

  return { rows: out, derived, conflicts: uniqueConflicts };
}
