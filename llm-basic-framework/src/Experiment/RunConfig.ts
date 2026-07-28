import type { LlmCallOptions, LlmSamplingSupport } from '../LlmClient/LlmClientBackendBase';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

export interface GitState {
  sha: string | null;
  dirty: boolean;
  /**
   * sha256 of `git diff HEAD` when the tree is dirty, else null. Without this a dirty tree
   * makes two different code states share a runId — the exact silent-resume hazard the runId
   * exists to prevent.
   */
  diffHash: string | null;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface SamplingRecord {
  /** What was actually sent, after unsupported parameters were dropped. */
  effective: LlmCallOptions;
  /** What the provider accepts, so "absent" is distinguishable from "unsupported". */
  supported: LlmSamplingSupport;
}

export interface RunConfigInput {
  condition: string;
  orchestration: string;
  input: { path: string; contentHash: string; fileCount: number };
  llm: ModelRef;
  embeddings?: ModelRef;
  sampling: SamplingRecord;
  seed: number | null;
  order: string;
  /** Prompt id → sha256. Populated by M6's PromptProvider; empty until then. */
  promptHashes?: Record<string, string>;
  /** Condition-specific blocks (candidates/decision/repair) — arrive with M4/M6/M7. */
  extra?: Record<string, unknown>;
}

export interface ResolvedRunConfig extends RunConfigInput {
  promptHashes: Record<string, string>;
  git: GitState;
  runId: string;
}

/**
 * Deterministic JSON: object keys sorted recursively, so a runId cannot change because a config
 * was assembled in a different order. Arrays keep their order (it is meaningful).
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        const child = (node as Record<string, unknown>)[key];
        if (child !== undefined) out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function readGitState(): GitState {
  const sha = git(['rev-parse', 'HEAD'])?.trim() ?? null;
  if (sha === null) return { sha: null, dirty: false, diffHash: null };

  const status = git(['status', '--porcelain'])?.trim() ?? '';
  const dirty = status.length > 0;
  const diff = dirty ? git(['diff', 'HEAD']) : null;

  return {
    sha,
    dirty,
    diffHash: diff === null ? null : crypto.createHash('sha256').update(diff).digest('hex'),
  };
}

/**
 * runId = sha256(canonical config + git sha + dirty-diff hash + prompt hashes), truncated.
 *
 * Config alone is not enough: a code or prompt change would otherwise reuse an existing run
 * directory and the `existsSync` resume skips would silently continue a run across versions.
 *
 * Since M6 the prompts live in `prompts/` as files, so `promptHashes` is load-bearing: a prompt can
 * now change with no code change at all, and without this field two such runs would share a runId.
 * Callers get the hashes from `PromptProvider.hashes()`; `bin/app.ts` passes all of them.
 */
export function computeRunId(
  config: RunConfigInput,
  git: GitState,
  promptHashes: Record<string, string>
): string {
  const material = canonicalJson({
    condition: config.condition,
    orchestration: config.orchestration,
    input: config.input,
    llm: config.llm,
    embeddings: config.embeddings ?? null,
    sampling: config.sampling.effective,
    seed: config.seed,
    order: config.order,
    extra: config.extra ?? null,
    gitSha: git.sha,
    gitDiffHash: git.diffHash,
    promptHashes,
  });

  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
  // Condition prefix keeps run directories human-navigable; the digest is what guarantees identity.
  const slug = config.condition.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
  return `${slug}-${digest}`;
}

export function resolveRunConfig(config: RunConfigInput): ResolvedRunConfig {
  const git = readGitState();
  const promptHashes = config.promptHashes ?? {};
  return {
    ...config,
    promptHashes,
    git,
    runId: computeRunId(config, git, promptHashes),
  };
}
