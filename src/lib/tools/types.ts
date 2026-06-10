import type { Category, ItemRef } from '../categories.js';
import type { CatalogItem } from '../library.js';

export const TOOL_IDS = ['claude', 'codex', 'cursor', 'opencode'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

/** One file of a rendered item; relativePath is POSIX, relative to the output root. */
export interface RenderedFile {
  /** For single-file roots this is the file's basename (mirrors walkFiles). */
  readonly relativePath: string;
  readonly content: Buffer;
}

/**
 * Files synlin fully owns under the tool's config dir: a directory tree or a
 * single file (isFile). rootPath is project-root-relative POSIX and must start
 * with the adapter's configDirName.
 */
export interface OwnedTreeOutput {
  readonly kind: 'owned-tree';
  readonly rootPath: string;
  readonly isFile: boolean;
  readonly files: readonly RenderedFile[];
}

/**
 * A marker-delimited region synlin manages inside a shared file (e.g. AGENTS.md).
 * blockId is the item id by convention, so tools sharing a file share the block.
 */
export interface ManagedBlockOutput {
  readonly kind: 'managed-block';
  readonly filePath: string;
  readonly blockId: string;
  /** Body without markers, normalized to end with exactly one "\n". */
  readonly body: string;
}

export type RenderedOutput = OwnedTreeOutput | ManagedBlockOutput;

export interface RenderedItem {
  readonly outputs: readonly RenderedOutput[];
}

export type SupportLevel = 'supported' | 'unsupported';

/** Result of recognizing a path inside a tool's config space for `synlin import`. */
export interface InferredImport {
  readonly ref: ItemRef;
  /** Absolute path of the item root (file or directory) to import from. */
  readonly sourcePath: string;
  /** Set when the file is a converted (lossy) copy that must not be imported directly. */
  readonly convertedFrom?: string;
}

/**
 * Per-tool install adapter. render() must be deterministic: a pure function of
 * the library item's content — no clocks, env, or filesystem beyond sourcePath.
 */
export interface ToolAdapter {
  readonly id: ToolId;
  readonly displayName: string;
  /** Project-level config dir name, e.g. ".claude" — drives discovery + containment. */
  readonly configDirName: string;
  /** Project-root-relative shared files this adapter may write blocks into. */
  readonly sharedFiles: readonly string[];
  supports(category: Category): SupportLevel;
  /** User-facing reason for unsupported categories. */
  unsupportedReason(category: Category): string | undefined;
  render(item: CatalogItem): RenderedItem;
}
