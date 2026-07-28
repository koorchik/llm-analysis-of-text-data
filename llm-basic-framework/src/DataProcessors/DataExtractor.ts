import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import type { LlmClient } from '../LlmClient/LlmClient';
import {
  extractAndParseJson,
  normalizeRawData,
  UnifiedData,
} from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

type Preprocessor = (
  content: string
) => Promise<{ text: string; metadata: Record<string, string | number> }>;

interface Params {
  inputDir: string;
  outputDir: string;
  llmClient: LlmClient;
  preprocessor?: Preprocessor;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
}

export class DataExtractor {
  public readonly inputDir: string;
  public readonly outputDir: string;

  #llmClient: LlmClient;
  #preprocessor: Preprocessor = (content: string) =>
    Promise.resolve({
      text: content,
      metadata: {},
    });

  #prompts: PromptProvider;

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;

    if (params.preprocessor) {
      this.#preprocessor = params.preprocessor;
    }
  }

  async run() {
    if (!existsSync(this.outputDir)) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    const files = await fs.readdir(this.inputDir);

    for (const file of files) {
      console.log(`IN FILE=${this.inputDir}/${file}`);
      const content = await fs.readFile(`${this.inputDir}/${file}`);
      const data = await this.#preprocessor(content.toString());

      const started = Date.now();
      const response = await this.#sendToLlm(data.text);
      const spent = (Date.now() - started) / 1000;

      await this.#saveResponse(
        file,
        JSON.stringify(
          {
            ...response,
            metadata: { ...data.metadata, llmProcessingTimeSeconds: spent },
          },
          undefined,
          2
        )
      );
      // break;
    }
  }

  async #sendToLlm(text: string): Promise<UnifiedData | {}> {
    const instructions = this.#prompts.render('extract-batch');

    console.time('LLM PROCESSING');
    const response = await this.#llmClient.send(instructions, text, {
      operator: 'extract-batch',
    });
    console.timeEnd('LLM PROCESSING');
    console.time('EXTRACT_JSON');
    console.log({ result: response.text });
    // TODO: check if result contains JSON
    const rawData = extractAndParseJson(response.text);
    console.timeEnd('EXTRACT_JSON');

    if (!rawData) return {};

    console.time('NORMALIZE_DATA');
    const normalizedData = normalizeRawData(rawData);
    console.timeEnd('NORMALIZE_DATA');
    return normalizedData || {};
  }

  async #saveResponse(originalFile: string, text: string) {
    const rawResultFile = `${this.outputDir}/${originalFile}`;
    console.log(`OUT FILE=${rawResultFile}`);
    await fs.writeFile(rawResultFile, text);
  }
}
