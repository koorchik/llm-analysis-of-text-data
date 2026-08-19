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
  /**
   * How many candidates to show. The plan's k≈4 is not arbitrary: a long list makes the position
   * effect worse and costs tokens for options the generator already ranked as unlikely.
   */
  k?: number;
  /** Prompt id, so an E8 judge-swap arm can point at different text without a new class. */
  promptId?: string;
}

interface Choice {
  mention: string;
  category: string;
  choice: number;
}

/**
 * The current judge, upgraded so **mint is an explicit option in the list** rather than the absence
 * of a link.
 *
 * The pre-M6 prompt asked for `"link" | "mint"` plus a target — two decisions in one answer, where
 * the mint case is expressed by *not* choosing. That framing has two problems this class fixes:
 *
 * 1. **Mint is not on the ballot.** The model is asked to pick a target and separately allowed to
 *    decline; declining is the unmarked option, and unmarked options are chosen less often. Making
 *    "NEW ENTITY" option *n+1* puts both outcomes on the same footing.
 * 2. **The target had to be echoed as a string**, so a verdict could name something that was not a
 *    candidate at all, and the old code silently dropped those. An option number cannot be
 *    off-list — it is either in range or malformed, and malformed is visible.
 *
 * **Position bias is real, so the list order is fixed and stated.** Candidates arrive ordered by
 * `compareCandidates` (descending similarity, then name), which is deterministic across runs and
 * machines. The alternative — shuffling to average the bias out — would need a seeded permutation
 * recorded per call to stay replayable, and would make E4's per-channel recall harder to read. The
 * prompt instead tells the model the ordering is not evidence. Whether that works is itself
 * measurable: a variant arm can shuffle and the difference is the position effect.
 *
 * Never returns `defer`. An LLM asked to abstain will abstain, and a deferral rate that reflects
 * prompt wording rather than genuine ambiguity would be worse than no abstention at all. Abstention
 * belongs to strategies with a calibrated middle region — see `FellegiSunterDecision`.
 */
export class ListwiseMintCandidateDecision implements DecisionStrategy {
  public readonly id = 'listwise-mint-candidate';
  public readonly config: Record<string, unknown>;

  #llmClient: LlmClient;
  #decisionLog?: DecisionLog;
  #prompts: PromptProvider;
  #k: number;
  #promptId: string;

  constructor(params: Params) {
    this.#llmClient = params.llmClient;
    this.#decisionLog = params.decisionLog;
    this.#prompts = params.prompts ?? defaultPrompts;
    this.#k = params.k ?? 4;
    this.#promptId = params.promptId ?? 'listwise-select';

    if (this.#k < 1) throw new Error(`ListwiseMintCandidateDecision: k must be >= 1, got ${this.#k}`);

    this.config = {
      k: this.#k,
      promptId: this.#promptId,
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

    // Mentions with no candidates have nothing to choose between; sending them would spend tokens
    // on a foregone answer and pad the list the model has to keep straight.
    const askable = requests
      .map((request, index) => ({ request, index }))
      .filter((entry) => entry.request.candidates.length > 0);

    const decisions: Decision[] = requests.map(() => mintOf('no candidates'));
    if (askable.length === 0) return decisions;

    // The option list per mention, capped at k, with NEW ENTITY always last.
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
    const text = `${header}${context}\nMentions:\n${lines.join('\n')}`;

    const started = Date.now();
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(this.#prompts.render(this.#promptId), text, {
        operator: 'listwise-select',
        docId: first.docId,
      });

      const parsed = extractAndParseJson(response.text);
      const rawChoices: unknown[] = Array.isArray(parsed?.choices) ? parsed!.choices : [];

      // Prompt variants may use a compact positional integer array. It avoids repeating every
      // mention and category in the response, and exact length makes omissions unambiguous.
      if (rawChoices.length === askable.length && rawChoices.every(Number.isInteger)) {
        rawChoices.forEach((choice, position) => {
          const { index } = askable[position];
          decisions[index] = decisionForOption(choice as number, options.get(index)!);
        });
        return decisions;
      }

      const choices = rawChoices.filter(
        (choice): choice is Choice => Boolean(choice) && typeof choice === 'object'
      );

      // Key by category|mention, exactly as the caller does. Keying by mention alone loses a verdict
      // whenever one document carries the same surface under two categories — the bug this
      // milestone fixes in StreamingNormalizer.
      const byKey = new Map<string, Choice>();
      for (const choice of choices) {
        if (!choice || typeof choice.mention !== 'string') continue;
        byKey.set(keyOf(choice.category ?? '', choice.mention), choice);
      }

      for (const { request, index } of askable) {
        const shown = options.get(index)!;
        const choice =
          byKey.get(keyOf(request.category, request.mention)) ??
          // Category omitted by the model: fall back to the mention alone, but only when it is
          // unambiguous in this batch. Guessing when two categories share a surface is what
          // produced the cross-category mis-assignment in the first place.
          unambiguousByMention(byKey, askable, request.mention);

        if (!choice || !Number.isInteger(choice.choice)) {
          decisions[index] = mintOf('no usable choice returned');
          continue;
        }
        decisions[index] = decisionForOption(choice.choice, shown);
      }

      return decisions;
    } catch (error) {
      // Mint-all is conservative and repairable later (StreamingRepairer phase 2, or the RQ3
      // batch-reference harness over a copied run) — never abort the document.
      console.error(`LISTWISE-SELECT failed for doc ${first.docId}, minting all:`, error);
      return requests.map(() => mintOf('judge call failed'));
    } finally {
      await this.#decisionLog?.logLlmCall({
        doc: first.docId,
        kind: 'listwise-select',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }
}

function decisionForOption(option: number, shown: string[]): Decision {
  if (option === shown.length + 1) {
    return { kind: 'mint', target: null, confidence: null, reason: 'judge chose NEW ENTITY' };
  }
  if (option >= 1 && option <= shown.length) {
    return {
      kind: 'link',
      target: shown[option - 1],
      confidence: null,
      reason: `judge chose option ${option} of ${shown.length + 1}`,
    };
  }
  return {
    kind: 'mint',
    target: null,
    confidence: null,
    reason: `choice ${option} out of range 1..${shown.length + 1}`,
  };
}

/**
 * The prompt renders each mention in quotes (`1. "RemcosLoader" (Software)`), and a judge that reads
 * carefully echoes it back the way it was shown — `"mention": "\"RemcosLoader\""`. Keying on the raw
 * string dropped those verdicts and minted instead, so a *more* literal judge scored worse: measured
 * on `gemma4:26b-16k`, which lost both `shellcode.x*.bin` merges this way while having answered them
 * correctly. Fold the wrapping quotes away before keying.
 */
const fold = (value: string) =>
  value
    .trim()
    .replace(/^["'`«»“”„]+|["'`«»“”„]+$/g, '')
    .trim()
    .toLowerCase();

const keyOf = (category: string, mention: string) => `${fold(category)}|${fold(mention)}`;

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
