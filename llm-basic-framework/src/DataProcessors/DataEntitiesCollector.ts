import type { LlmClient } from '../LlmClient/LlmClient';
import { extractAndParseJson, UnifiedData, Category } from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

interface Params {
  inputDir: string;
  outputDir: string;
  llmClient: LlmClient;
  maxRetries?: number;
  retryDelay?: number;
}

export class DataEntitiesCollector {
  public readonly inputDir: string;
  public readonly outputDir: string;
  #llmClient: LlmClient;
  #maxRetries: number;
  #retryDelay: number;

  constructor(params: Params) {
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;
    this.#maxRetries = params.maxRetries ?? 3;
    this.#retryDelay = params.retryDelay ?? 2000;
  }

  async run() {
    if (!existsSync(this.outputDir)) {
      await fs.mkdir(this.outputDir, { recursive: true });
    }

    // Load existing data to resume processing
    const existingData = await this.#loadExistingData();

    const entitiesByCategory = await this.#gatherEntities();

    // Process each category
    for (const [category, entities] of Object.entries(entitiesByCategory)) {
      if (entities.length === 0) continue;

      const categoryKey = category as Category;

      // Skip already processed categories
      if (
        existingData.entities[categoryKey] &&
        Object.keys(existingData.entities[categoryKey]).length > 0
      ) {
        console.log(
          `Skipping already processed category: ${category} (${
            Object.keys(existingData.entities[categoryKey]).length
          } entities already normalized)`
        );
        continue;
      }

      console.log(`Processing category: ${category} (${entities.length} entities)`);
      const normalized = await this.#sendToLlm(category, entities);

      // Update the data structure with normalized entities for this category
      existingData.entities[categoryKey] = normalized;

      // Save incrementally after processing each category
      await this.#saveResponse(existingData);

      console.log(
        `Saved progress for category: ${category} (${Object.keys(normalized).length} entities normalized)`
      );
    }

    console.log('All categories processed successfully');

    // Display statistics
    this.#displayStatistics(existingData.entities);
  }

  #displayStatistics(entities: Record<Category, Record<string, string>>) {
    console.log('\n========== ENTITY NORMALIZATION STATISTICS ==========');

    let totalOriginal = 0;
    let totalNormalized = 0;

    for (const [category, categoryEntities] of Object.entries(entities)) {
      const originalCount = Object.keys(categoryEntities).length;
      const normalizedNames = new Set(Object.values(categoryEntities));
      const normalizedCount = normalizedNames.size;

      if (originalCount > 0) {
        const reductionPercent = (
          ((originalCount - normalizedCount) / originalCount) *
          100
        ).toFixed(1);
        console.log(`\n${category}:`);
        console.log(`  Original entities: ${originalCount}`);
        console.log(`  Normalized to: ${normalizedCount}`);
        console.log(
          `  Reduction: ${reductionPercent}% (${originalCount - normalizedCount} duplicates merged)`
        );

        totalOriginal += originalCount;
        totalNormalized += normalizedCount;
      }
    }

    if (totalOriginal > 0) {
      const totalReductionPercent = (
        ((totalOriginal - totalNormalized) / totalOriginal) *
        100
      ).toFixed(1);
      console.log('\n---------- TOTAL ----------');
      console.log(`Total original entities: ${totalOriginal}`);
      console.log(`Total normalized entities: ${totalNormalized}`);
      console.log(
        `Overall reduction: ${totalReductionPercent}% (${totalOriginal - totalNormalized} duplicates merged)`
      );
    }

    console.log('\n====================================================\n');
  }

  async #gatherEntities() {
    const files = await fs.readdir(this.inputDir);

    const entitiesByCategory: Record<Category, string[]> = {
      Organization: [],
      HackerGroup: [],
      Software: [],
      Country: [],
      Individual: [],
      Domain: [],
      Sector: [],
      'Government Body': [],
      Infrastructure: [],
      Device: [],
    };

    for (const file of files) {
      const data = await fs.readFile(`${this.inputDir}/${file}`);
      const content = JSON.parse(data.toString()) as UnifiedData;

      if (!content.entities) continue;

      for (const entity of content.entities) {
        if (entity.name && !entitiesByCategory[entity.category].includes(entity.name)) {
          entitiesByCategory[entity.category].push(entity.name);
        }
      }
    }

    return entitiesByCategory;
  }

  async #sendToLlm(entityType: string, entities: string[]): Promise<Record<string, string>> {
    const uniqueEntities = [...new Set(entities)];

    const instructions = `
      You are a data normalization expert. Your task is to normalize the following list of ${entityType} entities.
      Group similar entities together and provide a single normalized name for each group.
      
      For example:
      - "Microsoft Corp", "Microsoft Corporation", "MSFT" should all map to "Microsoft Corporation"
      - "APT28", "Fancy Bear", "Sofacy Group" should all map to "APT28"
      
      Return a JSON object where each key is the original entity name and the value is the normalized name.
      If an entity doesn't need normalization, map it to itself.
      
      Return ONLY a JSON object in this format:
      {
        "original_name_1": "normalized_name_1",
        "original_name_2": "normalized_name_2"
      }
    `;

    const text = `Entities to normalize: ${JSON.stringify(uniqueEntities, null, 2)}`;

    let attempts = 0;
    while (attempts < this.#maxRetries) {
      try {
        console.time(`LLM NORMALIZATION - ${entityType}`);
        const result = await this.#llmClient.send(instructions, text);
        console.timeEnd(`LLM NORMALIZATION - ${entityType}`);

        console.log(result);

        const parsed = extractAndParseJson(result);
        if (parsed) {
          // Ensure all entities have a mapping
          const normalized: Record<string, string> = {};
          for (const entity of uniqueEntities) {
            normalized[entity] = parsed[entity] || entity;
          }
          return normalized;
        }
      } catch (error) {
        console.error(`Attempt ${attempts + 1} failed for ${entityType}:`, error);
        attempts++;
        if (attempts < this.#maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.#retryDelay));
        }
      }
    }

    // Fallback: map each entity to itself
    const fallback: Record<string, string> = {};
    for (const entity of uniqueEntities) {
      fallback[entity] = entity;
    }
    return fallback;
  }

  async #loadExistingData(): Promise<{
    entities: Record<Category, Record<string, string>>;
  }> {
    const entitiesFile = `${this.outputDir}/entities.json`;

    // Initialize with empty categories
    const defaultData: { entities: Record<Category, Record<string, string>> } = {
      entities: {
        Organization: {},
        HackerGroup: {},
        Software: {},
        Country: {},
        Individual: {},
        Domain: {},
        Sector: {},
        'Government Body': {},
        Infrastructure: {},
        Device: {},
      },
    };

    if (!existsSync(entitiesFile)) {
      return defaultData;
    }

    try {
      const data = await fs.readFile(entitiesFile, 'utf-8');
      const parsed = JSON.parse(data);

      // Merge parsed data with default structure to ensure all categories exist
      if (parsed && parsed.entities) {
        return {
          entities: { ...defaultData.entities, ...parsed.entities },
        };
      }

      return defaultData;
    } catch (error) {
      console.warn('Failed to load existing entities file, starting fresh:', error);
      return defaultData;
    }
  }

  async #saveResponse(data: any) {
    const entitiesFile = `${this.outputDir}/entities.json`;
    console.log(`OUT FILE=${entitiesFile}`);
    await fs.writeFile(entitiesFile, JSON.stringify(data, undefined, 2));
  }
}
