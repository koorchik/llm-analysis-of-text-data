import crypto from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Versioned prompt templates, loaded from `prompts/` and hashed into the run card.
 *
 * **Why this exists.** Before M6 all ten prompts were inline template literals, so a prompt change
 * was invisible to the run card: two runs could differ in the single most behaviour-determining input
 * and be indistinguishable afterwards. Phase 1.5 requires every run to record its prompt text, and
 * E8 (judge swap) and prompt-sensitivity measurement are impossible without it. This is also what
 * finally makes `promptHashes` in the `runId` load-bearing — until now it was wired through but empty,
 * because a prompt could only change alongside a code change, which the git sha already covered.
 *
 * **`psi-norm-batch` is the published Ψ_norm prompt** — the exact artifact E1 exists to score. It is
 * extracted like the others so E1 can record what it ran.
 *
 * **Extraction was mechanical, not manual.** A script read the exact characters of each template
 * literal out of the source and replaced `${expr}` with `{{name}}`, so byte-identity with the
 * pre-M6 inline text is guaranteed by construction rather than by careful copying. The plan's Risk #4
 * ("extract verbatim first, hash, verify an identical run, and only then introduce variants") is
 * satisfied by that plus the recorded hashes, which lock the text going forward.
 */

export interface PromptTemplate {
  id: string;
  template: string;
  sha256: string;
  /** Placeholder names the template expects, in first-appearance order. */
  variables: string[];
}

interface Params {
  /** Defaults to `<repo>/prompts`. */
  dir?: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** `.md` files in `prompts/` that are documentation rather than prompts. */
const NON_PROMPT_FILES = new Set(['README']);

export class PromptProvider {
  public readonly dir: string;

  #cache = new Map<string, PromptTemplate>();

  constructor(params: Params = {}) {
    this.dir = params.dir ?? path.resolve(__dirname, '../../prompts');
  }

  /** Every prompt id present on disk, sorted. */
  ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/, ''))
      // README.md documents the directory; it is not a prompt and must not reach a run card.
      .filter((id) => !NON_PROMPT_FILES.has(id))
      .sort();
  }

  get(id: string): PromptTemplate {
    const cached = this.#cache.get(id);
    if (cached) return cached;

    const file = path.join(this.dir, `${id}.md`);
    if (!existsSync(file)) {
      // Fatal: a missing prompt must not fall back to a default, or a run would silently use text
      // nobody chose and the run card would record a hash for a file that was never read.
      throw new Error(`PromptProvider: no prompt "${id}" at ${file}`);
    }

    const template = readFileSync(file, 'utf8');
    const variables: string[] = [];
    for (const match of template.matchAll(PLACEHOLDER)) {
      if (!variables.includes(match[1])) variables.push(match[1]);
    }

    const loaded: PromptTemplate = {
      id,
      template,
      sha256: crypto.createHash('sha256').update(template, 'utf8').digest('hex'),
      variables,
    };
    this.#cache.set(id, loaded);
    return loaded;
  }

  /**
   * Render a template. Every placeholder must be supplied and every supplied variable must be used —
   * both directions are errors.
   *
   * Strict on purpose. A missing variable would leave a literal `{{knownRelationTypes}}` in the
   * prompt, which the model would silently do its best with; an unused one usually means a caller and
   * a template have drifted apart. Either way the run would produce plausible output from a prompt
   * nobody intended.
   */
  render(id: string, variables: Record<string, string> = {}): string {
    const prompt = this.get(id);

    const missing = prompt.variables.filter((name) => variables[name] === undefined);
    if (missing.length > 0) {
      throw new Error(`PromptProvider: prompt "${id}" needs ${missing.join(', ')}`);
    }
    const unused = Object.keys(variables).filter((name) => !prompt.variables.includes(name));
    if (unused.length > 0) {
      throw new Error(`PromptProvider: prompt "${id}" does not use ${unused.join(', ')}`);
    }

    return prompt.template.replace(PLACEHOLDER, (_match, name: string) => variables[name]);
  }

  /** `{ id: sha256 }` for every prompt on disk — the shape the run card records. */
  hashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of this.ids()) out[id] = this.get(id).sha256;
    return out;
  }

  /** Hashes for a named subset, for a run that uses only some prompts. */
  hashesFor(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of ids) out[id] = this.get(id).sha256;
    return out;
  }
}

/** Shared default instance. Prompts are immutable at runtime, so one is enough. */
export const prompts = new PromptProvider();
