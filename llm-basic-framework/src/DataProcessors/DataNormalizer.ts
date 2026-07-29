import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';
import { UnifiedData } from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

interface Params {
  inputDir: string;
  outputDir: string;
  countryNameNormalizer: CountryNameNormalizer;
  embeddingsClient: EmbeddingsClient;
  entitiesFile: string;
  /**
   * M5. Off by default, because turning it on changes what this processor writes and the committed
   * `normalized/{model}/` corpus — 204 files, every `embedding` an empty array — is what the batch
   * arm's artifacts are compared against. `bin/app.ts` redirects the output into the run directory
   * when this is on, so the two can never be confused.
   */
  embeddingsEnabled?: boolean;
}

/** The entities whose vectors DataAnalyzer's t-SNE plots. Unchanged from the pre-M5 gate. */
const EMBEDDED_CATEGORIES = ['Infrastructure', 'Sector', 'Device'];

interface UnifiedEntities {
  entities: Record<string, Record<string, string>>;
  // Structure: { entities: { Category: { originalName: normalizedName } } }
}

export class DataNormalizer {
  public readonly inputDir: string;
  public readonly outputDir: string;
  #countryNameNormalizer: CountryNameNormalizer;
  #embeddingsClient: EmbeddingsClient;
  #entitiesFile: string;
  #embeddingsEnabled: boolean;

  constructor(params: Params) {
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#countryNameNormalizer = params.countryNameNormalizer;
    this.#embeddingsClient = params.embeddingsClient;
    this.#entitiesFile = params.entitiesFile;
    this.#embeddingsEnabled = params.embeddingsEnabled ?? false;
  }

  async run() {
    const data = await fs.readFile(this.#entitiesFile);
    const entities = JSON.parse(data.toString()) as UnifiedEntities;

    console.log(entities);

    if (!existsSync(this.outputDir)) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    const files = await fs.readdir(this.inputDir);
    for (const file of files) {
      console.log(`IN FILE=${this.inputDir}/${file}`);
      const content = await fs.readFile(`${this.inputDir}/${file}`);
      const data = JSON.parse(content.toString()) as UnifiedData;
      const response = await this.#normalizeAndEnrich(data, entities);
      await this.#saveResponse(file, JSON.stringify(response, undefined, 2));
    }
  }

  async #normalizeAndEnrich(data: UnifiedData, entities: UnifiedEntities): Promise<UnifiedData> {
    if (!data.entities) return data;

    const toEmbed: UnifiedData['entities'] = [];

    for (const entity of data.entities) {
      // Normalize countries
      if (entity.category === 'Country') {
        const countryCode = await this.#countryNameNormalizer.normalizeCountry(entity.name);
        entity.code = countryCode;
      }

      // Look up normalized names from entities file
      // The entities file structure is: { entities: { Category: { originalName: normalizedName } } }
      if (
        entities.entities &&
        entities.entities[entity.category] &&
        entities.entities[entity.category][entity.name]
      ) {
        entity.normalizedName = entities.entities[entity.category][entity.name];
      } else {
        // If no normalized name is found, use the original name
        entity.normalizedName = entity.name;
      }

      // Generate embeddings for certain categories
      if (EMBEDDED_CATEGORIES.includes(entity.category) && entity.role === 'Target') {
        entity.embedding = [];
        if (this.#embeddingsEnabled) toEmbed.push(entity);
      }
    }

    // One request per document rather than one per entity — the whole point of M5's batched
    // contract. Written after the loop so the whole document's whitelisted entities go together.
    if (toEmbed.length > 0) {
      const vectors = await this.#embeddingsClient.embed(
        toEmbed.map((entity) => entity.normalizedName || entity.name),
        { operator: 'embed-entities', docId: Number(data.metadata?.id) || null }
      );
      toEmbed.forEach((entity, index) => {
        entity.embedding = vectors[index];
      });
    }

    return data;
  }

  async #saveResponse(originalFile: string, text: string) {
    const resultFile = `${this.outputDir}/${originalFile}`;
    console.log(`OUT FILE=${resultFile}`);
    await fs.writeFile(resultFile, text);
  }
}
