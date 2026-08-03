import {
  annotatePairs,
  applyEnsemble,
  rowKey,
  selectForAnnotation,
  type PairAnnotation,
} from './llmAnnotate';
import type { WorksheetRow } from './worksheet';
import { normalizePairLabelVerdicts } from '../utils/validationUtils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const row = (overrides: Partial<WorksheetRow> = {}): WorksheetRow => ({
  label: '',
  suggested: 'review',
  rule: 'none',
  source: 'string',
  category: 'HackerGroup',
  left: 'A',
  right: 'B',
  stratum: 'a',
  mechanism: 'edit-similarity',
  sim: 0.8,
  evidence: '',
  ...overrides,
});

const annotation = (overrides: Partial<PairAnnotation> = {}): PairAnnotation => ({
  verdict: 'different',
  relation: '',
  direction: '',
  rationale: '',
  quote: '',
  ...overrides,
});

describe('normalizePairLabelVerdicts', () => {
  it('parses a well-formed verdict list', () => {
    const verdicts = normalizePairLabelVerdicts({
      verdicts: [
        { pair: 1, verdict: 'same', relation: null, direction: null, rationale: 'alias', quote: 'q' },
        { pair: 2, verdict: 'rung', relation: 'part-of', direction: 'left', rationale: 'unit', quote: '' },
      ],
    });
    assert.equal(verdicts?.length, 2);
    assert.equal(verdicts![0].verdict, 'same');
    assert.equal(verdicts![1].relation, 'part-of');
  });

  it('coerces an unknown verdict to unsure', () => {
    const verdicts = normalizePairLabelVerdicts({
      verdicts: [{ pair: 1, verdict: 'maybe', relation: null, direction: null, rationale: '', quote: '' }],
    });
    assert.equal(verdicts![0].verdict, 'unsure');
  });

  it('demotes a rung without a valid relation or direction to unsure', () => {
    const verdicts = normalizePairLabelVerdicts({
      verdicts: [
        { pair: 1, verdict: 'rung', relation: null, direction: 'left', rationale: '', quote: '' },
        { pair: 2, verdict: 'rung', relation: 'part-of', direction: 'up', rationale: '', quote: '' },
      ],
    });
    assert.equal(verdicts![0].verdict, 'unsure');
    assert.equal(verdicts![1].verdict, 'unsure');
  });

  it('fills the implied relation on rename and demotes one without a direction', () => {
    const verdicts = normalizePairLabelVerdicts({
      verdicts: [
        { pair: 1, verdict: 'rename', relation: null, direction: 'right', rationale: '', quote: '' },
        { pair: 2, verdict: 'rename', relation: null, direction: null, rationale: '', quote: '' },
      ],
    });
    assert.equal(verdicts![0].verdict, 'rename');
    assert.equal(verdicts![0].relation, 'renamed-to');
    assert.equal(verdicts![1].verdict, 'unsure');
  });

  it('clears relation and direction on flat verdicts', () => {
    const verdicts = normalizePairLabelVerdicts({
      verdicts: [
        { pair: 1, verdict: 'same', relation: 'isa', direction: 'left', rationale: '', quote: '' },
      ],
    });
    assert.equal(verdicts![0].relation, '');
    assert.equal(verdicts![0].direction, '');
  });
});

describe('annotatePairs', () => {
  const respond = (verdicts: unknown[]) => JSON.stringify({ verdicts });

  it('annotates rows in category batches and maps results by row key', async () => {
    const sent: string[] = [];
    const client = {
      send: async (_instructions: string, text: string) => {
        sent.push(text);
        const count = (text.match(/^\d+\. /gm) ?? []).length;
        return {
          text: respond(
            Array.from({ length: count }, (_, i) => ({
              pair: i + 1,
              verdict: 'different',
              relation: null,
              direction: null,
              rationale: 'r',
              quote: '',
            }))
          ),
        };
      },
    };
    const rows = [
      row({ left: 'A', right: 'B' }),
      row({ left: 'C', right: 'D', category: 'Software' }),
      row({ left: 'E', right: 'F', category: 'Software' }),
    ];
    const result = await annotatePairs(rows, { client, instructions: 'label pairs', promptSha: 'sha1' });
    assert.equal(result.size, 3);
    assert.equal(result.get(rowKey(rows[0]))?.verdict, 'different');
    assert.equal(sent.length, 2, 'one call per category at this batch size');
    assert.ok(sent[0].includes('Category: HackerGroup'));
  });

  it('marks the whole batch unsure on a count mismatch instead of misaligning', async () => {
    const client = {
      send: async () => ({
        text: respond([{ pair: 1, verdict: 'same', relation: null, direction: null, rationale: '', quote: '' }]),
      }),
    };
    const rows = [row({ left: 'A', right: 'B' }), row({ left: 'C', right: 'D' })];
    const result = await annotatePairs(rows, { client, instructions: 'i', promptSha: 's' });
    assert.equal(result.get(rowKey(rows[0]))?.verdict, 'unsure');
    assert.equal(result.get(rowKey(rows[1]))?.verdict, 'unsure');
  });

  it('marks a batch unsure when the response is not JSON', async () => {
    const client = { send: async () => ({ text: 'I refuse to answer in JSON.' }) };
    const rows = [row()];
    const result = await annotatePairs(rows, { client, instructions: 'i', promptSha: 's' });
    assert.equal(result.get(rowKey(rows[0]))?.verdict, 'unsure');
  });

  it('serves cached annotations without calling the client', async () => {
    let calls = 0;
    const store = new Map<string, PairAnnotation>();
    const cache = {
      get: (key: string) => store.get(key),
      put: (key: string, value: PairAnnotation) => void store.set(key, value),
    };
    const client = {
      send: async (_i: string, text: string) => {
        calls++;
        const count = (text.match(/^\d+\. /gm) ?? []).length;
        return {
          text: respond(
            Array.from({ length: count }, (_, i) => ({
              pair: i + 1,
              verdict: 'same',
              relation: null,
              direction: null,
              rationale: '',
              quote: '',
            }))
          ),
        };
      },
    };
    const rows = [row()];
    await annotatePairs(rows, { client, instructions: 'i', promptSha: 's', cache });
    assert.equal(calls, 1);
    const second = await annotatePairs(rows, { client, instructions: 'i', promptSha: 's', cache });
    assert.equal(calls, 1, 'second run is served from the cache');
    assert.equal(second.get(rowKey(rows[0]))?.verdict, 'same');
  });

  it('halves a failing batch once, then marks the remainder unsure', async () => {
    const attempts: number[] = [];
    const client = {
      send: async (_i: string, text: string) => {
        const count = (text.match(/^\d+\. /gm) ?? []).length;
        attempts.push(count);
        if (count > 1) throw new Error('batch too spicy');
        return {
          text: respond([{ pair: 1, verdict: 'different', relation: null, direction: null, rationale: '', quote: '' }]),
        };
      },
    };
    const rows = [row({ left: 'A', right: 'B' }), row({ left: 'C', right: 'D' })];
    const result = await annotatePairs(rows, { client, instructions: 'i', promptSha: 's' });
    assert.deepEqual(attempts, [2, 1, 1], 'full batch, then two singles');
    assert.equal(result.get(rowKey(rows[0]))?.verdict, 'different');
  });
});

describe('selectForAnnotation', () => {
  const sheet = [
    row({ left: 'U1', right: 'U2', rule: 'differing-digits', suggested: 'different' }),
    row({ left: 'U3', right: 'U4', rule: 'differing-digits', suggested: 'different' }),
    row({ left: 'U5', right: 'U6', rule: 'differing-digits', suggested: 'different' }),
    row({ left: 'P1', right: 'P2', rule: 'punctuation-only', suggested: 'same' }),
    row({ left: 'R1', right: 'R2', rule: 'registry-semantic', suggested: 'review' }),
  ];

  it('skips the digit-rule bulk except a seeded spot-check sample', () => {
    const { selected, spotCheckKeys } = selectForAnnotation(sheet, { spotCheck: 1, seed: 42 });
    const digitRows = selected.filter((r) => r.rule === 'differing-digits');
    assert.equal(digitRows.length, 1, 'exactly the spot-check sample');
    assert.equal(spotCheckKeys.size, 1);
    assert.ok(selected.some((r) => r.rule === 'punctuation-only'), 'rule-confident same rows are sent');
    assert.ok(selected.some((r) => r.rule === 'registry-semantic'));
  });

  it('is deterministic for a given seed', () => {
    const first = selectForAnnotation(sheet, { spotCheck: 2, seed: 7 });
    const second = selectForAnnotation(sheet, { spotCheck: 2, seed: 7 });
    assert.deepEqual(
      first.selected.map((r) => rowKey(r)),
      second.selected.map((r) => rowKey(r))
    );
  });

  it('never re-annotates a row the human already labelled', () => {
    const { selected } = selectForAnnotation([row({ label: 'same', rule: 'none' })], {});
    assert.equal(selected.length, 0);
  });
});

describe('applyEnsemble', () => {
  const vote = (map: Record<string, PairAnnotation>) =>
    new Map(Object.entries(map));

  it('prefills the label and queues an agreed positive in tier 3', () => {
    const rows = [row({ left: 'UAC-0002', right: 'Sandworm', stratum: 'c' })];
    const key = rowKey(rows[0]);
    const rung = annotation({ verdict: 'rung', relation: 'part-of', direction: 'left', rationale: 'designator', quote: 'UAC-0002 (Sandworm)' });
    const { rows: out } = applyEnsemble(rows, vote({ [key]: rung }), vote({ [key]: rung }));
    assert.equal(out[0].queue, 3);
    assert.equal(out[0].agreement, 'agree');
    assert.equal(out[0].label, 'rung');
    assert.equal(out[0].relation, 'part-of');
    assert.equal(out[0].direction, 'left');
    assert.equal(out[0].ensemble, 'rung:part-of:left');
    assert.equal(out[0].claudeVerdict, 'rung:part-of:left');
    assert.equal(out[0].evidence, 'UAC-0002 (Sandworm)', 'the agreed quote becomes born evidence');
  });

  it('queues an agreed different in tier 4 without prefilling evidence', () => {
    const rows = [row()];
    const key = rowKey(rows[0]);
    const { rows: out } = applyEnsemble(rows, vote({ [key]: annotation() }), vote({ [key]: annotation() }));
    assert.equal(out[0].queue, 4);
    assert.equal(out[0].label, 'different');
    assert.equal(out[0].evidence, '');
  });

  it('treats a relation mismatch as disagreement — tier 1, no label', () => {
    const rows = [row()];
    const key = rowKey(rows[0]);
    const { rows: out } = applyEnsemble(
      rows,
      vote({ [key]: annotation({ verdict: 'rung', relation: 'isa', direction: 'left' }) }),
      vote({ [key]: annotation({ verdict: 'rung', relation: 'part-of', direction: 'left' }) })
    );
    assert.equal(out[0].queue, 1);
    assert.equal(out[0].agreement, 'disagree');
    assert.equal(out[0].label, '');
  });

  it('queues an unsure vote in tier 2 even when the other model was confident', () => {
    const rows = [row()];
    const key = rowKey(rows[0]);
    const { rows: out } = applyEnsemble(
      rows,
      vote({ [key]: annotation({ verdict: 'unsure' }) }),
      vote({ [key]: annotation({ verdict: 'same' }) })
    );
    assert.equal(out[0].queue, 2);
    assert.equal(out[0].agreement, 'unsure');
    assert.equal(out[0].label, '');
  });

  it('leaves un-annotated rule rows in tier 5 as rule-only', () => {
    const rows = [row({ rule: 'differing-digits', suggested: 'different', label: 'different' })];
    const { rows: out } = applyEnsemble(rows, new Map(), new Map());
    assert.equal(out[0].queue, 5);
    assert.equal(out[0].agreement, 'rule-only');
    assert.equal(out[0].label, 'different', 'the rule label stands');
  });

  it('promotes a spot-check row that contradicts its rule to tier 1', () => {
    const rows = [row({ rule: 'differing-digits', suggested: 'different', label: 'different' })];
    const key = rowKey(rows[0]);
    const same = annotation({ verdict: 'same' });
    const { rows: out } = applyEnsemble(rows, vote({ [key]: same }), vote({ [key]: same }), new Set([key]));
    assert.equal(out[0].queue, 1);
    assert.equal(out[0].label, '', 'the contradicted rule label is cleared for review');
  });

  it('keeps a confirmed spot-check row in the bulk tier', () => {
    const rows = [row({ rule: 'differing-digits', suggested: 'different', label: 'different' })];
    const key = rowKey(rows[0]);
    const diff = annotation();
    const { rows: out } = applyEnsemble(rows, vote({ [key]: diff }), vote({ [key]: diff }), new Set([key]));
    assert.equal(out[0].queue, 5);
    assert.equal(out[0].label, 'different');
  });

  it('sorts by queue, then category, then similarity descending', () => {
    const a = row({ left: 'A1', right: 'A2', sim: 0.7 });
    const b = row({ left: 'B1', right: 'B2', sim: 0.95 });
    const c = row({ left: 'C1', right: 'C2', sim: 0.9, category: 'Software' });
    const votes = vote({
      [rowKey(a)]: annotation(),
      [rowKey(b)]: annotation(),
      [rowKey(c)]: annotation({ verdict: 'unsure' }),
    });
    const { rows: out } = applyEnsemble([a, b, c], votes, votes);
    assert.deepEqual(
      out.map((r) => r.left),
      ['C1', 'B1', 'A1'],
      'tier 2 first, then tier 4 by similarity'
    );
  });

  it('never overwrites a label the human already set', () => {
    const rows = [row({ label: 'different' })];
    const key = rowKey(rows[0]);
    const same = annotation({ verdict: 'same' });
    const { rows: out } = applyEnsemble(rows, vote({ [key]: same }), vote({ [key]: same }));
    assert.equal(out[0].label, 'different');
  });
});
