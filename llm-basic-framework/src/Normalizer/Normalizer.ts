import { PromptProvider, prompts } from "../Normalization/PromptProvider";
import type { LlmClient } from "../LlmClient/LlmClient";
import { getCountryCode, countries } from "countries-list";
import { extractAndParseJson } from "../utils/validationUtils";

interface NormalizerParams {
  llmClient: LlmClient;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
}

export class Normalizer {
  #llmClient: LlmClient;

  #prompts: PromptProvider;

  constructor(params: NormalizerParams) {
    this.#prompts = params.prompts ?? prompts;
    this.#llmClient = params.llmClient;
  }

  async normalizeAttackTarget(target: string) {
    const instructions = this.#prompts.render('normalize-target');

    // NOTE: this returned the bare `send()` result before M1, so widening the contract changed
    // its return type silently — tsc could not flag it because the value was passed straight
    // through. Kept returning a string. (This class is currently unreferenced; see M6.)
    const response = await this.#llmClient.send(instructions, target, {
      operator: 'normalize-target',
    });
    return response.text;
  }

  async normalizeCountry(country: string) {
    const countryCode = getCountryCode(country);
    if (countryCode) return countryCode;

    const instructions = this.#prompts.render('normalize-country', {
      countryCodes: Object.keys(countries).join(', '),
    });

    const response = await this.#llmClient.send(instructions, country, {
      operator: 'normalize-country',
    });
    const data = extractAndParseJson(response.text);
    return data?.normalized;
  }
}
