import { createHash } from 'node:crypto';
import { SynlinError } from './errors.js';

/**
 * Marker-delimited regions synlin manages inside shared files (AGENTS.md).
 * 'html' markers for markdown files; 'hash' (full-line # comments) reserved
 * for TOML shared files.
 */
export type MarkerStyle = 'html' | 'hash';

/** Header written when synlin creates a shared markdown file from scratch. */
const CREATED_FILE_HEADER = '# Project Rules';

function beginMarker(blockId: string, style: MarkerStyle): string {
  return style === 'html' ? `<!-- synlin:begin ${blockId} -->` : `# synlin:begin ${blockId}`;
}

function endMarker(blockId: string, style: MarkerStyle): string {
  return style === 'html' ? `<!-- synlin:end ${blockId} -->` : `# synlin:end ${blockId}`;
}

/** Normalize a block body to end with exactly one newline. */
export function normalizeBlockBody(body: string): string {
  return `${body.replace(/\n+$/, '')}\n`;
}

export function hashBlock(body: string): string {
  return `sha256:${createHash('sha256').update(normalizeBlockBody(body)).digest('hex')}`;
}

interface BlockLocation {
  readonly beginLine: number;
  readonly endLine: number;
}

function locateBlock(lines: readonly string[], blockId: string, style: MarkerStyle, context: string): BlockLocation | null {
  const begin = lines.findIndex((line) => line.trimEnd() === beginMarker(blockId, style));
  if (begin === -1) return null;
  const end = lines.findIndex((line, index) => index > begin && line.trimEnd() === endMarker(blockId, style));
  if (end === -1) {
    throw new SynlinError(
      `Corrupt synlin block "${blockId}" in ${context}: begin marker without a matching end marker. Restore the end marker or remove the block manually.`,
    );
  }
  return { beginLine: begin, endLine: end };
}

/** Body of a managed block (without markers), or null when the block is absent. */
export function readBlockBody(fileContent: string, blockId: string, style: MarkerStyle, context = 'shared file'): string | null {
  const lines = fileContent.split('\n');
  const location = locateBlock(lines, blockId, style, context);
  if (location === null) return null;
  const body = lines.slice(location.beginLine + 1, location.endLine).join('\n');
  return normalizeBlockBody(body);
}

/**
 * Insert or replace a managed block. Existing blocks are replaced in place;
 * new blocks are appended at EOF separated by one blank line. fileContent
 * null means the file does not exist yet — a fresh file with a header is produced.
 * Content outside the block is never touched.
 */
export function upsertBlock(fileContent: string | null, blockId: string, body: string, style: MarkerStyle, context = 'shared file'): string {
  const block = `${beginMarker(blockId, style)}\n${normalizeBlockBody(body)}${endMarker(blockId, style)}`;
  if (fileContent === null) {
    return `${CREATED_FILE_HEADER}\n\n${block}\n`;
  }
  const lines = fileContent.split('\n');
  const location = locateBlock(lines, blockId, style, context);
  if (location !== null) {
    const before = lines.slice(0, location.beginLine);
    const after = lines.slice(location.endLine + 1);
    return [...before, ...block.split('\n'), ...after].join('\n');
  }
  const trimmed = fileContent.replace(/\n+$/, '');
  if (trimmed === '') {
    return `${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Remove a managed block. Returns the remaining file content, or null when
 * nothing meaningful remains (caller deletes the file). Absent block → content
 * returned unchanged.
 */
export function removeBlock(fileContent: string, blockId: string, style: MarkerStyle, context = 'shared file'): string | null {
  const lines = fileContent.split('\n');
  const location = locateBlock(lines, blockId, style, context);
  if (location === null) return fileContent;

  let beforeEnd = location.beginLine;
  while (beforeEnd > 0 && lines[beforeEnd - 1]?.trim() === '') beforeEnd -= 1;
  let afterStart = location.endLine + 1;
  while (afterStart < lines.length && lines[afterStart]?.trim() === '') afterStart += 1;

  const before = lines.slice(0, beforeEnd);
  const after = lines.slice(afterStart);
  const remaining = [...before, ...(before.length > 0 && after.length > 0 ? [''] : []), ...after].join('\n');
  const meaningful = remaining.trim();
  if (meaningful === '' || meaningful === CREATED_FILE_HEADER) {
    return null;
  }
  return `${remaining.replace(/\n+$/, '')}\n`;
}
