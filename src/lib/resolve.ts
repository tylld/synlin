import { parseItemId } from './categories.js';

export interface Resolvable {
  readonly id: string;
}

export interface Resolution<T extends Resolvable> {
  readonly kind: 'found' | 'ambiguous' | 'unknown';
  readonly matches: readonly T[];
  readonly suggestions: readonly string[];
}

/**
 * Resolve a user-supplied name against a set of items (catalog or manifest ids).
 * Order: exact qualified id → bare-name match (last id segment, or the full
 * name for grouped rules) → unknown with suggestions.
 */
export function resolveName<T extends Resolvable>(items: readonly T[], query: string): Resolution<T> {
  const trimmed = query.trim();
  const qualified = parseItemId(trimmed);
  if (qualified) {
    const exact = items.filter((item) => item.id === trimmed);
    if (exact.length > 0) {
      return { kind: 'found', matches: exact, suggestions: [] };
    }
  }

  const bareMatches = items.filter((item) => {
    const name = item.id.split('/').slice(1).join('/');
    return name === trimmed || lastSegment(item.id) === trimmed;
  });
  if (bareMatches.length === 1) {
    return { kind: 'found', matches: bareMatches, suggestions: [] };
  }
  if (bareMatches.length > 1) {
    return { kind: 'ambiguous', matches: bareMatches, suggestions: [] };
  }
  return { kind: 'unknown', matches: [], suggestions: suggest(items, trimmed) };
}

function lastSegment(id: string): string {
  const segments = id.split('/');
  return segments[segments.length - 1] ?? id;
}

function suggest(items: readonly Resolvable[], query: string): readonly string[] {
  const lowered = query.toLowerCase();
  const prefix = lowered.slice(0, 3);
  const scored = items
    .map((item) => ({ id: item.id, score: suggestionScore(item.id, lowered, prefix) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((candidate) => candidate.id);
  return Object.freeze(scored);
}

function suggestionScore(id: string, lowered: string, prefix: string): number {
  const last = lastSegment(id).toLowerCase();
  if (last === lowered) return 100;
  if (last.includes(lowered) || lowered.includes(last)) return 50;
  if (id.toLowerCase().includes(lowered)) return 40;
  if (prefix.length >= 3 && last.startsWith(prefix)) return 20;
  return 0;
}
