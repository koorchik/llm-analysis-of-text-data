import type { DecisionLog } from '../../DecisionLog/DecisionLog';
import type { LlmClient } from '../../LlmClient/LlmClient';
import type { LlmResponse } from '../../LlmClient/LlmClientBackendBase';
import { extractAndParseJson } from '../../utils/validationUtils';
import { PromptProvider, prompts as defaultPrompts } from '../PromptProvider';
import type { Candidate, Decision, DecisionRequest, DecisionStrategy } from '../types';

interface Params {
  llmClient: LlmClient;
  decisionLog?: DecisionLog;
  prompts?: PromptProvider;
  /** COMEM's selecting strategy shows the top candidates only; k≈4 matches the published setting. */
  k?: number;
  promptId?: string;
}

/**
 * COMEM's *selecting* strategy, reproduced faithfully — **one call per mention**, records serialized
 * as attribute–value pairs, and "none of the above" as option 0.
 *
 * The point of this arm is comparability, not efficiency. `ListwiseMintCandidateDecision` already
 * puts mint on the ballot and is cheaper; what it does *not* do is match the published protocol,
 * because it batches every mention in a document into one call and serializes candidates as free
 * text. Those two departures are exactly the kind that make a reproduction incomparable, so this
 * class keeps the protocol and pays for it.
 *
 * **It will cost roughly one call per unresolved mention** rather than one per document — on this
 * corpus, a large multiple. That is the finding, not a defect: the note records COMEM at 86.42 F1
 * for $0.09 per 400 anchors against HierGAT's 83.34 at $1.10, and reproducing the quality number
 * without reproducing the call pattern would make the cost comparison meaningless.
 *
 * Two honest caveats to carry into the write-up:
 * - COMEM matches structured records with real attributes (title, brand, price). Registry entries
 *   have a name, alias surfaces and an optional gloss, so the serialization here is thinner than the
 *   benchmarks it is being compared against. Differences in absolute F1 partly reflect that.
 *   Compare the *direction* of arm-to-arm differences, not absolute numbers against the paper.
 * - The ComEM repository carries no LICENSE file, so this is a reimplementation from the paper's
 *   description, not vendored code.
 *
 * Never returns `defer` — see the note in {@link ListwiseMintCandidateDecision}; the reasoning is
 * the same and applies to every LLM-judged arm.
 */
export class ComemSelectDecision implements DecisionStrategy {
  public readonly id = 'comem-select';
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
    this.#promptId = params.promptId ?? 'comem-select';

    if (this.#k < 1) throw new Error(`ComemSelectDecision: k must be >= 1, got ${this.#k}`);

    this.config = {
      k: this.#k,
      promptId: this.#promptId,
      promptSha256: this.#prompts.get(this.#promptId).sha256,
      callsPerMention: 1,
    };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    const decisions: Decision[] = [];
    // Sequential, not concurrent: the arm's headline number is cost per document, and firing the
    // calls in parallel would change latency without changing cost while making rate-limit
    // behaviour differ from the batched arms it is compared against.
    for (const request of requests) {
      decisions.push(await this.#decideOne(request));
    }
    return decisions;
  }

  async #decideOne(request: DecisionRequest): Promise<Decision> {
    const mint = (reason: string): Decision => ({
      kind: 'mint',
      target: null,
      confidence: null,
      reason,
    });

    if (request.candidates.length === 0) return mint('no candidates');

    const shown = request.candidates.slice(0, this.#k);
    const text = [
      'Record:',
      serialize({ canonical: request.mention, sim: 1, surfaces: [], channel: 'query' }, request.category),
      '',
      'Candidates:',
      ...shown.map((candidate, index) => `${index + 1}. ${serialize(candidate, request.category)}`),
      '0. none of the above',
      ...(request.docSnippet ? ['', `Source evidence: ${request.docSnippet}`] : []),
    ].join('\n');

    const started = Date.now();
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(this.#prompts.render(this.#promptId), text, {
        operator: 'comem-select',
        docId: request.docId,
      });

      const parsed = extractAndParseJson(response.text);
      const selected = parsed?.selected;
      if (!Number.isInteger(selected)) return mint('no usable selection returned');
      if (selected === 0) return mint('judge selected none of the above');
      if (selected < 1 || selected > shown.length) {
        return mint(`selection ${selected} out of range 0..${shown.length}`);
      }

      return {
        kind: 'link',
        target: shown[selected - 1].canonical,
        confidence: null,
        reason: `judge selected candidate ${selected} of ${shown.length}`,
      };
    } catch (error) {
      console.error(`COMEM-SELECT failed for "${request.mention}" in doc ${request.docId}:`, error);
      return mint('judge call failed');
    } finally {
      await this.#decisionLog?.logLlmCall({
        doc: request.docId,
        kind: 'comem-select',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }
}

/**
 * COMEM's attribute–value serialization. Attributes are always emitted in the same order and empty
 * ones are omitted, so two runs over the same registry state produce byte-identical prompts.
 */
function serialize(candidate: Candidate, category: string): string {
  const parts = [`name: ${candidate.canonical}`, `category: ${category}`];
  // Drop the canonical from its own alias list — mint() stores it there, and repeating it would
  // spend tokens saying nothing and make one candidate look better attested than another.
  const aliases = candidate.surfaces.filter(
    (surface) => surface.trim().toLowerCase() !== candidate.canonical.trim().toLowerCase()
  );
  if (aliases.length > 0) parts.push(`aliases: ${aliases.join(', ')}`);
  return parts.join(' | ');
}
