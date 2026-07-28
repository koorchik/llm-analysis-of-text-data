import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import type { DecisionLog } from '../DecisionLog/DecisionLog';
import type { LlmClient } from '../LlmClient/LlmClient';
import { extractAndParseJson } from '../utils/validationUtils';
import { getCountryCode, countries } from 'countries-list';

interface Params {
  llmClient: LlmClient;
  /**
   * M1 blind spot #1: before this, every LLM call made here was invisible — no timing, no
   * tokens, no cost. Optional so existing constructions keep working, but app.ts passes one.
   */
  decisionLog?: DecisionLog;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
}

export class CountryNameNormalizer {
  #llmClient: LlmClient;
  #decisionLog?: DecisionLog;

  #prompts: PromptProvider;

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.#llmClient = params.llmClient;
    this.#decisionLog = params.decisionLog;
  }

  /** `docId` is optional only because the batch flow has no document in scope here. */
  async normalizeCountry(country: string, docId?: number) {
    const countryCode = getCountryCode(country);
    if (countryCode) return countryCode;

    const instructions = this.#prompts.render('country-normalize', {
      countryCodes: Object.keys(countries).join(', '),
    });

    const started = Date.now();
    const response = await this.#llmClient.send(instructions, country, {
      operator: 'country-normalize',
      docId: docId ?? null,
    });
    await this.#decisionLog?.logLlmCall({
      doc: docId ?? -1,
      kind: 'country-normalize',
      seconds: (Date.now() - started) / 1000,
      model: response.model,
      promptTokens: response.usage.inputTokens,
      completionTokens: response.usage.outputTokens,
    });

    const data = extractAndParseJson(response.text);
    return data?.normalized;
  }
}
