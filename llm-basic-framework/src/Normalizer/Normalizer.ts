import type { LlmClient } from "../LlmClient/LlmClient";
import { getCountryCode, countries } from "countries-list";
import { extractAndParseJson } from "../utils/validationUtils";

interface NormalizerParams {
  llmClient: LlmClient;
}

export class Normalizer {
  #llmClient: LlmClient;

  constructor(params: NormalizerParams) {
    this.#llmClient = params.llmClient;
  }

  async normalizeAttackTarget(target: string) {
    const instructions = `
      You are text normalization expert. Your goal is to normalize names, so it can be used to for clustering later.
      As input you get a text and should return only normalized version of it in English.
      Please return the extracted information in the exact JSON format specified below and nothing else: 
      { "normalized": "lower case some normalized text" }

      Prefer something from the following list, otherwise return own option:
      - "military departments other countries"
    `;

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

    const instructions = `
      You should normalize country name to country code from the following list:
      ${Object.keys(countries).join(", ")}
      Please return the extracted information in the exact JSON format specified below and nothing else: 
      { "normalized": "CODE" }
    `;

    const response = await this.#llmClient.send(instructions, country, {
      operator: 'normalize-country',
    });
    const data = extractAndParseJson(response.text);
    return data?.normalized;
  }
}
