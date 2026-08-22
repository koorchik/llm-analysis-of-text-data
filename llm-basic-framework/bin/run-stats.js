#!/usr/bin/env node
/**
 * Deliverable §6.3 — per-document LLM call histogram from a run's decisions.jsonl, plus the
 * decision mix and ladder ensemble validity. Read-only; takes one or more run directories.
 *
 *   node run-stats.js <runDir> [<runDir> …]
 *
 * The deck asks for the FULL histogram (every call kind), not just link-judge counts.
 */
const fs = require('fs');
const path = require('path');

function load(runDir) {
  const file = path.join(runDir, 'decisions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const events = [];
  let torn = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      torn += 1; // a live run can leave the final line half-written
    }
  }
  return { events, torn };
}

function docOf(e) {
  const d = e.docId ?? e.doc;
  return typeof d === 'number' ? d : -1;
}

function pct(n, d) {
  return d === 0 ? '—' : ((100 * n) / d).toFixed(1) + '%';
}

for (const runDir of process.argv.slice(2)) {
  const card = JSON.parse(fs.readFileSync(path.join(runDir, 'run-card.json'), 'utf8'));
  const { events, torn } = load(runDir);

  const docs = new Set();
  const callsByKind = {};
  const callsPerDoc = {};
  const tokensByKind = {};
  const decisions = { link: 0, mint: 0, defer: 0 };
  const edges = {};
  let seconds = 0;

  for (const e of events) {
    const doc = docOf(e);
    if (doc >= 0) docs.add(doc);
    if (e.kind) {
      callsByKind[e.kind] = (callsByKind[e.kind] || 0) + 1;
      if (doc >= 0) callsPerDoc[doc] = (callsPerDoc[doc] || 0) + 1;
      seconds += e.seconds || 0;
      const t = (tokensByKind[e.kind] ??= { in: 0, out: 0 });
      t.in += e.promptTokens || 0;
      t.out += e.completionTokens || 0;
    }
    if (e.op === 'decision' && decisions[e.decision] !== undefined) decisions[e.decision] += 1;
    if (e.op === 'broader-edge' || e.op === 'granularity-edge') {
      const label = e.type ?? e.relation ?? e.kind ?? 'untyped';
      edges[label] = (edges[label] || 0) + 1;
    }
  }

  const nDocs = docs.size;
  const totalCalls = Object.values(callsByKind).reduce((a, b) => a + b, 0);
  // Over EVERY document, including the free ones (all mentions hit the exact-alias fast path and
  // made no call at all) — omitting those would overstate the per-document call rate.
  const perDoc = [...docs].map((doc) => callsPerDoc[doc] || 0);
  const hist = {};
  for (const doc of docs) hist[callsPerDoc[doc] || 0] = (hist[callsPerDoc[doc] || 0] || 0) + 1;

  console.log('='.repeat(78));
  console.log(`RUN   ${card.runId}`);
  console.log(`ARM   ${card.condition} — ${card.config.llm.provider}/${card.config.llm.model}`);
  const ladderModels = card.config?.extra?.ladder?.ensembleModels;
  console.log(`      ladder: ${ladderModels || `${card.config.extra.ladder.ensembleN}× session model`}`);
  console.log(`      blocker: ${card.config.extra.candidateGenerator} | judge: ${card.config.extra.decisionStrategy}`);
  if (torn) console.log(`      (${torn} unparsable line(s) — run still writing)`);
  console.log(`DOCS  ${nDocs}`);
  console.log('');

  console.log('LLM calls by kind:');
  for (const [kind, n] of Object.entries(callsByKind).sort((a, b) => b[1] - a[1])) {
    const t = tokensByKind[kind];
    console.log(
      `  ${kind.padEnd(20)} ${String(n).padStart(5)}  ${pct(n, totalCalls).padStart(6)}` +
        `   tokens in/out ${String(t.in).padStart(8)}/${String(t.out).padStart(8)}` +
        `   ${(n / Math.max(nDocs, 1)).toFixed(2)}/doc`
    );
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(totalCalls).padStart(5)}`);
  console.log('');

  console.log('Calls per document (histogram):');
  for (const k of Object.keys(hist).map(Number).sort((a, b) => a - b)) {
    console.log(`  ${String(k).padStart(2)} call(s): ${String(hist[k]).padStart(4)} doc(s)  ${'#'.repeat(Math.min(hist[k], 60))}`);
  }
  const sorted = perDoc.slice().sort((a, b) => a - b);
  if (sorted.length) {
    console.log(
      `  min ${sorted[0]} · median ${sorted[Math.floor(sorted.length / 2)]} · max ${sorted[sorted.length - 1]}` +
        ` · mean ${(totalCalls / nDocs).toFixed(2)}`
    );
  }
  console.log('');

  const totalDecisions = decisions.link + decisions.mint + decisions.defer;
  console.log(
    `Decisions: link ${decisions.link} (${pct(decisions.link, totalDecisions)}) · ` +
      `mint ${decisions.mint} (${pct(decisions.mint, totalDecisions)}) · ` +
      `defer ${decisions.defer} (${pct(decisions.defer, totalDecisions)})   [deferral rate is a §5 withheld decision]`
  );
  console.log(`Granularity edges: ${JSON.stringify(edges)}`);
  console.log(`LLM wall-clock in calls: ${(seconds / 60).toFixed(1)} min`);
  console.log(`Cost block: ${JSON.stringify(card.cost)}`);
}
