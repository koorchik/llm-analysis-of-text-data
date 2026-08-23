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
  /**
   * Judge-call self-consistency for sampled local judges: ask the same ballot `samples` times and
   * union the hierarchy halves (identity and glosses come from the first usable sample — identity
   * never flipped in any measured run). Motivated by gemma4:12b's bimodal ballots: a response
   * asserts a co-mentioned family nearly completely (~26/27) or not at all, at roughly ⅓ heads,
   * and no prompt wording moved that rate (probe 2026-08-23). Heads-samples are near-perfect
   * precision, so the union adds recall without meaningful precision cost. Default 1 (off).
   */
  samples?: number;
  /** Per-strategy decoding overrides (v8 hybrid: review pass runs think:false + temperature 0 —
   *  deterministic and measured best there — while the identity pass keeps the model defaults,
   *  where hidden reasoning is load-bearing for written-form linking). */
  think?: boolean;
  temperature?: number;
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
 * The relation is stated in SKOS / ISO 25964 terms: identity is a link (exact match), and
 * `v`/`n`/`p` make the mention the narrower side of a skos:broader edge (typed BTI/BTG/BTP) while
 * `b` makes it the broader side (`mentionIsBroader`, endpoints swapped by the caller at write
 * time). Either way the parent must be an option that was actually on the ballot, so a strategy
 * can never invent an endpoint.
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
  #samples: number;
  #think?: boolean;
  #temperature?: number;

  constructor(params: Params) {
    this.#llmClient = params.llmClient;
    this.#decisionLog = params.decisionLog;
    this.#prompts = params.prompts ?? defaultPrompts;
    this.#k = params.k ?? 4;
    this.#promptId = params.promptId ?? 'listwise-graph-v2';
    this.#samples = Math.max(1, params.samples ?? 1);
    this.#think = params.think;
    this.#temperature = params.temperature;
    // The SKOS ballot speaks the compact dialect (E-numbered entities, {"v":[...]}) by design;
    // the identity-only pass-1 prompts (listwise-id-*) render the same ballot and answer in JSONL.
    this.#compact =
      this.#promptId.includes('compact') ||
      this.#promptId.includes('skos') ||
      this.#promptId.includes('-id-');

    if (this.#k < 1) throw new Error(`ListwiseGraphDecision: k must be >= 1, got ${this.#k}`);

    this.config = {
      k: this.#k,
      promptId: this.#promptId,
      dialect: this.#compact ? 'compact' : 'verbose',
      promptSha256: this.#prompts.get(this.#promptId).sha256,
      samples: this.#samples,
      ...(this.#think !== undefined ? { think: this.#think } : {}),
      ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
    };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    const target = this.#samples;
    const samples: Decision[][] = [];
    let last: Decision[] | null = null;
    // One spare attempt beyond `target`, spent on the first unusable response (empty content after
    // a thinking overrun — the measured gemma failure mode), so a single dud does not consume a
    // sample. All later duds are kept as-is: they merge as no-ops.
    const maxAttempts = target + 1;
    for (let attempt = 0; attempt < maxAttempts && samples.length < target; attempt++) {
      const sample = await this.#decideOnce(requests);
      last = sample;
      const unusable = sample.every((decision) =>
        ['judge call failed', 'no usable verdict returned', 'no usable choice returned', 'no candidates'].includes(
          decision.reason ?? ''
        )
      );
      if (unusable && maxAttempts - attempt - 1 >= target - samples.length) continue;
      samples.push(sample);
    }
    if (samples.length === 0 && last) samples.push(last);

    const merged = samples[0];
    for (const sample of samples.slice(1)) {
      sample.forEach((decision, index) => {
        const base = merged[index];
        if (base.kind !== 'mint' || decision.kind !== 'mint') return;
        if (!base.parentCandidate && decision.parentCandidate) {
          merged[index] = {
            ...base,
            parentCandidate: decision.parentCandidate,
            broaderType: decision.broaderType,
            ...(decision.mentionIsBroader ? { mentionIsBroader: true } : {}),
            reason: `${base.reason} (parent from sample union)`,
          };
        }
        if (!merged[index].gloss && decision.gloss) {
          merged[index] = { ...merged[index], gloss: decision.gloss };
        }
      });
    }
    return merged;
  }

  async #decideOnce(requests: DecisionRequest[]): Promise<Decision[]> {
    const mintOf = (reason: string): Decision => ({
      kind: 'mint',
      target: null,
      confidence: null,
      reason,
    });

    // Zero-candidate requests stay on the ballot when the caller sent them (judgeUnresolved):
    // their identity options render as "none" (id must be NEW — links are only ever accepted to
    // shown options), but `p` may point anywhere in the shared entity list.
    const askable = requests
      .map((request, index) => ({ request, index }))
      .filter((entry) => entry.request.candidates.length > 0 || entry.request.pool?.length);

    const decisions: Decision[] = requests.map(() => mintOf('no candidates'));
    if (askable.length === 0) return decisions;

    const options = new Map<number, string[]>();
    const lines = askable.map(({ request, index }, position) => {
      const shown = request.candidates.slice(0, this.#k);
      options.set(index, shown.map((candidate) => candidate.canonical));
      const rendered = shown
        .map(
          (candidate, option) =>
            `     ${option + 1}. ${candidate.canonical} [aliases: ${candidate.surfaces.join(', ')}]`
        )
        .join('\n');
      return `${position + 1}. "${request.mention}" (${request.category})\n${rendered}\n     ${shown.length + 1}. NEW ENTITY`;
    });

    const first = askable[0].request;
    const header = first.docTitle ? `Source: "${first.docTitle}"` : 'Source: untitled';
    const context = first.docSnippet ? ` — evidence: ${first.docSnippet}` : '';

    // One pool for the whole call, numbered P1…Pn. Parents are chosen from it by number for the
    // same reason identity is: a number cannot name something that was never offered.
    const pool: Array<{ canonical: string; surfaces: string[] }> = [];
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
          .map((entry, index) => `  P${index + 1}. ${entry.canonical}`)
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
        ...(this.#think !== undefined ? { think: this.#think } : {}),
        ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
      });

      // JSONL dialect (listwise-id-*): one verdict object per line, no wrapping array — a
      // truncated big ballot yields every complete line instead of nothing. Collected into the
      // compact shape so one applier serves both dialects.
      const parsed = this.#promptId.includes('-id-')
        ? { v: jsonlVerdicts(response.text) }
        : extractAndParseJson(response.text);
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
        return `E${index + 1}. ${entity.canonical}${aliases.length ? ` [aka ${aliases.join(', ')}]` : ''}`;
      })
      .join('\n');

    const mentionBlock = askable
      .map(({ request, index }, position) => {
        const shown = options.get(index)!;
        const refs = shown
          .map((canonical) => numberOf.get(canonical.toLowerCase()))
          .filter((number): number is number => Boolean(number))
          .map((number) => `E${number}`);
        const ctx = request.contextRef ? ` — ctx: ${request.contextRef}` : '';
        // Kin: the mention's embedding-near co-mentions, by E number — hierarchy pointers on the
        // row itself, kept out of the identity options (see DecisionRequest.kinRefs).
        const kinRefs = (request.kinRefs ?? [])
          .map((name) => numberOf.get(name.toLowerCase()))
          .filter((number): number is number => Boolean(number))
          .map((number) => `E${number}`);
        const kin = kinRefs.length ? ` — kin: ${kinRefs.join(', ')}` : '';
        return `M${position + 1}. "${request.mention}" (${request.category}) — options: ${
          refs.length ? refs.join(', ') : 'none'
        }${ctx}${kin}`;
      })
      .join('\n');

    return [header, `Entities:\n${entityBlock}`, `Mentions:\n${mentionBlock}`].join('\n');
  }

  /** The document's entity list: every pooled entity, in first-seen order so numbering is stable. */
  #entityList(
    askable: Array<{ request: DecisionRequest; index: number }>
  ): Array<{ canonical: string; surfaces: string[] }> {
    const entities: Array<{ canonical: string; surfaces: string[] }> = [];
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
      // Codes come in two dialects — single letters (v|n|p|b, the measured winner) and full words
      // (version|narrower|part|broader, the skos-v2 ablation). They map onto the ISO 25964
      // broader-term typology: v = BTI (instance/version), n = BTG (generic/is-a), p = BTP
      // (partitive). `b`/`broader` reverses the edge: the mention is the broader side, so it
      // stores as BTG with the endpoints swapped by the caller (parent → mention).
      const code = typeof verdict.r === 'string' ? verdict.r.trim().toLowerCase() : '';
      const broaderType =
        code === 'v' || code === 'version'
          ? ('broaderInstantial' as const)
          : code === 'n' || code === 'narrower' || code === 'b' || code === 'broader'
            ? ('broaderGeneric' as const)
            : code === 'p' || code === 'part'
              ? ('broaderPartitive' as const)
              : null;
      const mentionIsBroader = code === 'b' || code === 'broader';
      const gloss = typeof verdict.g === 'string' && verdict.g.trim() ? verdict.g.trim() : null;

      decisions[index] = {
        kind: 'mint',
        target: null,
        confidence: null,
        reason: parent
          ? mentionIsBroader
            ? `judge chose NEW above ${verdict.p} (broader)`
            : `judge chose NEW under ${verdict.p} (${broaderType ?? 'unspecified'})`
          : 'judge chose NEW',
        gloss,
        parentCandidate: parent,
        broaderType,
        ...(mentionIsBroader ? { mentionIsBroader } : {}),
      };
    });

    this.#applyEdgeList(parsed, askable, entities, decisions);

    return decisions;
  }

  /**
   * The set-level dialect (listwise-skos-v4): hierarchy arrives as a top-level `e` list of
   * {n, b, r} pairs over the shared entity numbers, not as per-mention `p`/`r`. Each edge is
   * carried by the decision of the mention it anchors — the narrower side when that is one of this
   * ballot's minted mentions, otherwise the broader side with the endpoints marked swapped. Edges
   * between two entities that are not mentions of this ballot have no decision to ride on and are
   * dropped: the doc path can only journal through a mention's outcome.
   */
  #applyEdgeList(
    parsed: Record<string, unknown> | null | undefined,
    askable: Array<{ request: DecisionRequest; index: number }>,
    entities: Array<{ canonical: string; surfaces: string[] }>,
    decisions: Decision[]
  ): void {
    const raw = (parsed as { e?: unknown } | null)?.e;
    if (!Array.isArray(raw)) return;

    const mintedAt = new Map<string, number>();
    for (const { request, index } of askable) {
      if (decisions[index].kind === 'mint') mintedAt.set(fold(request.mention), index);
    }

    // The prompt asks for E numbers, but mentions are labelled M on the same ballot and a model
    // sometimes answers in that register; both resolve to a canonical name.
    const endpointAt = (ref: unknown): string | null => {
      if (typeof ref !== 'string') return null;
      const match = /^([EM])(\d+)$/i.exec(ref.trim());
      if (!match) return null;
      const number = Number(match[2]);
      if (match[1].toUpperCase() === 'M') {
        return number >= 1 && number <= askable.length ? askable[number - 1].request.mention : null;
      }
      return number >= 1 && number <= entities.length ? entities[number - 1].canonical : null;
    };

    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const edge = entry as { n?: unknown; b?: unknown; r?: unknown };
      const narrower = endpointAt(edge.n);
      const broader = endpointAt(edge.b);
      if (!narrower || !broader || fold(narrower) === fold(broader)) continue;

      const code = typeof edge.r === 'string' ? edge.r.trim().toLowerCase() : '';
      const broaderType =
        code === 'v'
          ? ('broaderInstantial' as const)
          : code === 'n'
            ? ('broaderGeneric' as const)
            : code === 'p'
              ? ('broaderPartitive' as const)
              : null;
      if (!broaderType) continue;

      const asNarrower = mintedAt.get(fold(narrower));
      const asBroader = mintedAt.get(fold(broader));
      const carrier = asNarrower ?? asBroader;
      if (carrier === undefined || decisions[carrier].parentCandidate) continue;

      const mentionIsBroader = asNarrower === undefined;
      decisions[carrier] = {
        ...decisions[carrier],
        reason: `judge asserted edge ${edge.n}->${edge.b} (${broaderType})`,
        parentCandidate: mentionIsBroader ? narrower : broader,
        broaderType,
        ...(mentionIsBroader ? { mentionIsBroader } : {}),
      };
    }
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

  // The verbose prompts (listwise-graph-v1/v2) answer in the legacy relation vocabulary — a
  // frozen LLM-output dialect, mapped onto the ISO 25964 typing here.
  const broaderType =
    choice.relation === 'version-of'
      ? ('broaderInstantial' as const)
      : choice.relation === 'narrower-of'
        ? ('broaderGeneric' as const)
        : choice.relation === 'part-of'
          ? ('broaderPartitive' as const)
          : null;

  return {
    kind: 'mint',
    target: null,
    confidence: null,
    reason,
    gloss,
    parentCandidate: parent,
    broaderType,
  };
}

/** Parse a JSONL response: every line that is a complete JSON object becomes a verdict; broken
 *  or extraneous lines are skipped, so truncation costs a suffix rather than the whole ballot. */
function jsonlVerdicts(text: string): CompactVerdict[] {
  const verdicts: CompactVerdict[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/,+$/, '');
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.m === 'string') {
        verdicts.push(parsed as CompactVerdict);
      }
    } catch {
      continue;
    }
  }
  return verdicts;
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
