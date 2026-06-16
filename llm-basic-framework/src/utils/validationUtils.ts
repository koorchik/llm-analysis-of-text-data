import { jsonrepair } from 'jsonrepair'

import LIVR from 'livr';
LIVR.Validator.defaultAutoTrim(true);

const validator = new LIVR.Validator({
  entities: [{ default: [[]] }, {
    listOfObjects: [{
      name: ['required', 'string'],
      category: ['required', 'string', { 
        oneOf: [
          'Organization', 
          'HackerGroup', 
          'Software', 
          'Country', 
          'Individual', 
          'Domain', 
          'Sector', 
          'Government Body', 
          'Infrastructure', 
          'Device'
        ] 
      }],
      role: ['required', 'string', { oneOf: ['Target', 'Attacker', 'Neutral'] }]
    }]
  }]
});

interface RawData {
  [key: string]: any
};

export type Category = 
  | 'Organization' 
  | 'HackerGroup' 
  | 'Software' 
  | 'Country' 
  | 'Individual' 
  | 'Domain' 
  | 'Sector' 
  | 'Government Body' 
  | 'Infrastructure' 
  | 'Device';

export type Role = 'Target' | 'Attacker' | 'Neutral';

export interface Entity {
  name: string;
  category: Category;
  role: Role;
  embedding?: number[];
  normalizedName?: string;
  code?: string; // For countries
}

export interface UnifiedData {
  entities: Entity[];
  metadata?: Record<string, string | number>;
}

export function extractAndParseJson(text: string): RawData | undefined {
  const matched = text.match(/\{[\s\S]+\}/g);
  if (!matched) return;

  try {
    const repaired = jsonrepair(matched[0]);
    return JSON.parse(repaired);
  } catch (error) {
    return;
  }
}

export function normalizeRawData(data: RawData): UnifiedData | undefined {
  const validData = validator.validate(data);
  console.log(data);
  if (!validData) {
    console.log({ERROR: validator.getErrors()});
    return;
  }

  // Filter out empty entities and normalize domain names to lowercase
  validData.entities = validData.entities
    .filter((entity: Entity) => entity.name && entity.name.trim())
    .map((entity: Entity) => {
      if (entity.category === 'Domain') {
        entity.name = entity.name.toLowerCase();
      }
      return entity;
    });

  // Remove duplicates based on name, category, and role
  const seen = new Set<string>();
  validData.entities = validData.entities.filter((entity: Entity) => {
    const key = `${entity.name}|${entity.category}|${entity.role}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return validData as UnifiedData;
}
