import type { DecisionLog } from '../../DecisionLog/DecisionLog';
import type { LlmClient } from '../../LlmClient/LlmClient';
import type { LlmResponse } from '../../LlmClient/LlmClientBackendBase';
import { extractAndParseJson } from '../../utils/validationUtils';
import { PromptProvider, prompts as defaultPrompts } from '../PromptProvider';
import type { Decision, DecisionRequest, DecisionStrategy } from '../types';

interface Params {
  llmClient: LlmClient;
  decisionLog?: DecisionLog;
  prompts?: PromptProvider;
  k?: number;
  promptId?: string;
}

interface Choice {
  mention: string;
  category: string;
  choice: number;
  parent?: number | null;
  relation?: string | null;
  gloss?: string | null;
}

/**
 * The compact dialect: one `E`-numbered entity list shared by identity and parents, one `M` number
 * per mention, and single-letter keys.
 *
 * Output tokens dominate this call — the verbose dialect spends 3.5k output against 2.7k input per
 * document, most of it re-typing mention and category strings the caller already knows. Numbers are
 * also harder to hallucinate than names.
 */
interface CompactVerdict {
  m: string;
  id: string;
  p?: string | null;
  r?: string | null;
  lvl?: string | null;
  g?: string | null;
}

/**
 * `listwise-mint-candidate` plus the granularity half — **one call per document decides both the
 * identity partition and the edges between its clusters**.
 *
 * The flat strategy answers "same entity or not" and stops there, which leaves the ladder inert:
 * every arm running it emitted zero granularity edges, so `MS Office 2010` and `Microsoft Office`
 * ended as two unrelated clusters and no later analysis could fold one into the other. Splitting
 * that into a second pass would double the calls and, worse, ask about hierarchy without the
 * identity context that decided it — the two questions share their evidence, so they share a call.
 *
 * The ballot shape that made the flat strategy win is preserved exactly: numbered options, mint as
 * option *n+1* rather than the unmarked default, an option number instead of an echoed name. The
 * parent is a second option number on the same ballot, so it is equally un-inventable.
 *
 * **The model proposes; the ladder disposes where it can.** `StreamingNormalizer` derives the
 * stored `edgeKind` from the rung the parent sits on, and only when the category has no ladder yet
 * does it fall back to the `relation` the model stated. Either way the parent must be an option
 * that was actually on the ballot, so a strategy can never invent an endpoint.
 *
 * Never returns `defer`, for the reason `ListwiseMintCandidateDecision` documents.
 */
export class ListwiseGraphDecision implements DecisionStrategy {
  public readonly id = 'listwise-graph';
  public readonly config: Record<string, unknown>;

  #llmClient: LlmClient;
  #decisionLog?: DecisionLog;
  #prompts: PromptProvider;
  #k: number;
  #promptId: string;
  #compact: boolean;

  constructor(params: Params) {
    this.#llmClient = params.llmClient;
    this.#decisionLog = params.decisionLog;
    this.#prompts = params.prompts ?? defaultPrompts;
    this.#k = params.k ?? 4;
    this.#promptId = params.promptId ?? 'listwise-graph-v2';
    this.#compact = this.#promptId.includes('compact');

    if (this.#k < 1) throw new Error(`ListwiseGraphDecision: k must be >= 1, got ${this.#k}`);

    this.config = {
      k: this.#k,
      promptId: this.#promptId,
      dialect: this.#compact ? 'compact' : 'verbose',
      promptSha256: this.#prompts.get(this.#promptId).sha256,
    };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    const mintOf = (reason: string): Decision => ({
      kind: 'mint',
      target: null,
      confidence: null,
      reason,
    });

    const askable = requests
      .map((request, index) => ({ request, index }))
      .filter((entry) => entry.request.candidates.length > 0);

    const decisions: Decision[] = requests.map(() => mintOf('no candidates'));
    if (askable.length === 0) return decisions;

    const options = new Map<number, string[]>();
    const lines = askable.map(({ request, index }, position) => {
      const shown = request.candidates.slice(0, this.#k);
      options.set(index, shown.map((candidate) => candidate.canonical));
      const rendered = shown
        .map(
          (candidate, option) =>
            `     ${option + 1}. ${candidate.canonical}${
              candidate.rung ? ` [level ${candidate.rung}]` : ''
            } [aliases: ${candidate.surfaces.join(', ')}]`
        )
        .join('\n');
      const ladder = request.ladder && request.ladder !== '(none; use g0)' ? `; levels: ${request.ladder}` : '';
      return `${position + 1}. "${request.mention}" (${request.category})${ladder}\n${rendered}\n     ${shown.length + 1}. NEW ENTITY`;
    });

    const first = askable[0].request;
    const header = first.docTitle ? `Source: "${first.docTitle}"` : 'Source: untitled';
    const context = first.docSnippet ? ` — evidence: ${first.docSnippet}` : '';

    // One pool for the whole call, numbered P1…Pn. Parents are chosen from it by number for the
    // same reason identity is: a number cannot name something that was never offered.
    const pool: Array<{ canonical: string; surfaces: string[]; rung?: string }> = [];
    const seen = new Set<string>();
    for (const { request } of askable) {
      for (const entry of request.pool ?? []) {
        const key = entry.canonical.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(entry);
      }
    }
    const poolBlock = pool.length
      ? `Known entities in this source (possible parents):\n${pool
          .map(
            (entry, index) =>
              `  P${index + 1}. ${entry.canonical}${entry.rung ? ` [level ${entry.rung}]` : ''}`
          )
          .join('\n')}\n`
      : '';

    const text = this.#compact
      ? this.#compactText(header + context, askable, options)
      : `${header}${context}\n${poolBlock}Mentions:\n${lines.join('\n')}`;

    const started = Date.now();
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(this.#prompts.render(this.#promptId), text, {
        operator: 'listwise-graph',
        docId: first.docId,
      });

      const parsed = extractAndParseJson(response.text);
      if (this.#compact) {
        return this.#applyCompact(parsed ?? null, askable, options, decisions, mintOf);
      }
      const rawChoices: unknown[] = Array.isArray(parsed?.choices) ? parsed!.choices : [];
      const choices = rawChoices.filter(
        (choice): choice is Choice => Boolean(choice) && typeof choice === 'object'
      );

      const byKey = new Map<string, Choice>();
      for (const choice of choices) {
        if (!choice || typeof choice.mention !== 'string') continue;
        byKey.set(keyOf(choice.category ?? '', choice.mention), choice);
      }

      for (const { request, index } of askable) {
        const shown = options.get(index)!;
        const choice =
          byKey.get(keyOf(request.category, request.mention)) ??
          unambiguousByMention(byKey, askable, request.mention);

        if (!choice || !Number.isInteger(choice.choice)) {
          decisions[index] = mintOf('no usable choice returned');
          continue;
        }
        decisions[index] = decisionForChoice(choice, shown, pool, request.mention);
      }

      return decisions;
    } catch (error) {
      console.error(`LISTWISE-GRAPH failed for doc ${first.docId}, minting all:`, error);
      return requests.map(() => mintOf('judge call failed'));
    } finally {
      await this.#decisionLog?.logLlmCall({
        doc: first.docId,
        kind: 'listwise-graph',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }
  /**
   * The compact dialect's prompt body: one `E`-numbered entity list for the whole document, each
   * mention naming only the numbers of its own options. Names appear once instead of once per
   * mention that retrieved them, which is where the verbose dialect spends most of its input.
   */
  #compactText(
    header: string,
    askable: Array<{ request: DecisionRequest; index: number }>,
    options: Map<number, string[]>
  ): string {
    const entities = this.#entityList(askable);
    const numberOf = new Map(entities.map((entity, index) => [entity.canonical.toLowerCase(), index + 1]));

    const entityBlock = entities
      .map((entity, index) => {
        const aliases = entity.surfaces.filter(
          (surface) => surface.toLowerCase() !== entity.canonical.toLowerCase()
        );
        return `E${index + 1}. ${entity.canonical}${aliases.length ? ` [aka ${aliases.join(', ')}]` : ''}${
          entity.rung ? ` <${entity.rung}>` : ''
        }`;
      })
      .join('\n');

    const mentionBlock = askable
      .map(({ request, index }, position) => {
        const shown = options.get(index)!;
        const refs = shown
          .map((canonical) => numberOf.get(canonical.toLowerCase()))
          .filter((number): number is number => Boolean(number))
          .map((number) => `E${number}`);
        return `M${position + 1}. "${request.mention}" (${request.category}) — options: ${
          refs.length ? refs.join(', ') : 'none'
        }`;
      })
      .join('\n');

    // One line per category that has a ladder, each labelled. Pooling them unlabelled — which this
    // did until 2026-08-21 — shows a mention of one category the granularity vocabulary of another,
    // with nothing to tell them apart once a document mixes categories.
    const laddersByCategory = new Map<string, string>();
    for (const { request } of askable) {
      if (request.ladder && request.ladder !== '(none; use g0)') {
        laddersByCategory.set(request.category, request.ladder);
      }
    }
    const ladders = [...laddersByCategory.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, ladder]) => `${category}: ${ladder}`);

    return [
      header,
      `Entities:\n${entityBlock}`,
      ladders.length ? `Levels (per category):\n${ladders.map((line) => `  ${line}`).join('\n')}` : '',
      `Mentions:\n${mentionBlock}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The document's entity list: every pooled entity, in first-seen order so numbering is stable. */
  #entityList(
    askable: Array<{ request: DecisionRequest; index: number }>
  ): Array<{ canonical: string; surfaces: string[]; rung?: string }> {
    const entities: Array<{ canonical: string; surfaces: string[]; rung?: string }> = [];
    const seen = new Set<string>();
    for (const { request } of askable) {
      for (const entry of request.pool ?? []) {
        const key = entry.canonical.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push(entry);
      }
    }
    return entities;
  }

  #applyCompact(
    parsed: Record<string, unknown> | null | undefined,
    askable: Array<{ request: DecisionRequest; index: number }>,
    options: Map<number, string[]>,
    decisions: Decision[],
    mintOf: (reason: string) => Decision
  ): Decision[] {
    const entities = this.#entityList(askable);
    const raw = Array.isArray((parsed as { v?: unknown } | null)?.v)
      ? ((parsed as { v: unknown[] }).v as CompactVerdict[])
      : [];
    const byMention = new Map<string, CompactVerdict>();
    raw.forEach((verdict, position) => {
      if (!verdict || typeof verdict !== 'object') return;
      // `m` is the mention's number; fall back to position so a model that drops the key still lines
      // up, which a positional array cannot do once one entry is missing.
      const key = typeof verdict.m === 'string' ? verdict.m.trim().toUpperCase() : `M${position + 1}`;
      byMention.set(key, verdict);
    });

    askable.forEach(({ request, index }, position) => {
      const verdict = byMention.get(`M${position + 1}`);
      if (!verdict) {
        decisions[index] = mintOf('no usable verdict returned');
        return;
      }

      const shown = options.get(index)!;
      const entityAt = (ref: string | null | undefined): string | null => {
        if (typeof ref !== 'string') return null;
        const match = /^E(\d+)$/i.exec(ref.trim());
        if (!match) return null;
        const number = Number(match[1]);
        return number >= 1 && number <= entities.length ? entities[number - 1].canonical : null;
      };

      const linked = entityAt(verdict.id);
      // A link is only accepted to an option this mention was actually shown; the shared entity
      // list is wide enough that anything else would be a merge nobody proposed.
      if (linked && shown.some((canonical) => fold(canonical) === fold(linked))) {
        decisions[index] = {
          kind: 'link',
          target: shown.find((canonical) => fold(canonical) === fold(linked))!,
          confidence: null,
          reason: `judge chose ${verdict.id}`,
        };
        return;
      }

      const proposed = entityAt(verdict.p);
      const parent = proposed && fold(proposed) !== fold(request.mention) ? proposed : null;
      const relation = verdict.r === 'n' ? 'narrower-of' : verdict.r === 'p' ? 'part-of' : null;
      const gloss = typeof verdict.g === 'string' && verdict.g.trim() ? verdict.g.trim() : null;
      const rung = typeof verdict.lvl === 'string' && /^g\d+$/i.test(verdict.lvl.trim())
        ? verdict.lvl.trim().toLowerCase()
        : null;

      decisions[index] = {
        kind: 'mint',
        target: null,
        confidence: null,
        reason: parent ? `judge chose NEW under ${verdict.p} (${relation ?? 'unspecified'})` : 'judge chose NEW',
        gloss,
        parentCandidate: parent,
        relation,
        mentionRung: rung,
      };
    });

    return decisions;
  }
}

function decisionForChoice(
  choice: Choice,
  shown: string[],
  pool: Array<{ canonical: string }>,
  mention: string
): Decision {
  const option = choice.choice;
  const gloss = typeof choice.gloss === 'string' && choice.gloss.trim() ? choice.gloss.trim() : null;

  if (option >= 1 && option <= shown.length) {
    // A linked mention IS the option; a parent on top of that would claim it is also narrower than
    // something, so the graph half is ignored rather than half-applied.
    return {
      kind: 'link',
      target: shown[option - 1],
      confidence: null,
      reason: `judge chose option ${option} of ${shown.length + 1}`,
    };
  }

  const poolIndex = Number.isInteger(choice.parent) ? (choice.parent as number) : 0;
  const proposed = poolIndex >= 1 && poolIndex <= pool.length ? pool[poolIndex - 1].canonical : null;
  // A parent pointing back at the mention is a self-loop the registry would reject anyway; drop it
  // here so the reason string stays honest about what was recorded.
  const parent = proposed && fold(proposed) !== fold(mention) ? proposed : null;

  const reason =
    option === shown.length + 1
      ? parent
        ? `judge chose NEW ENTITY under "${parent}" (${choice.relation ?? 'unspecified'})`
        : 'judge chose NEW ENTITY'
      : `choice ${option} out of range 1..${shown.length + 1}`;

  const relation =
    choice.relation === 'narrower-of' || choice.relation === 'part-of' ? choice.relation : null;

  return {
    kind: 'mint',
    target: null,
    confidence: null,
    reason,
    gloss,
    parentCandidate: parent,
    relation,
  };
}

const keyOf = (category: string, mention: string) => `${fold(category)}|${fold(mention)}`;

/** Judges that read the prompt literally echo the mention with the quotes it was rendered in. */
const fold = (value: string) =>
  value
    .trim()
    .replace(/^["'`«»“”„]+|["'`«»“”„]+$/g, '')
    .trim()
    .toLowerCase();

function unambiguousByMention(
  byKey: Map<string, Choice>,
  askable: Array<{ request: DecisionRequest }>,
  mention: string
): Choice | undefined {
  const folded = fold(mention);
  const sameSurface = askable.filter((entry) => fold(entry.request.mention) === folded);
  if (sameSurface.length !== 1) return undefined;

  const matches = [...byKey.values()].filter((choice) => fold(choice.mention) === folded);
  return matches.length === 1 ? matches[0] : undefined;
}
