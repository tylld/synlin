import { describe, expect, it } from 'vitest';
import { firstHeading, parseFrontmatter } from '../src/lib/frontmatter.js';

describe('parseFrontmatter', () => {
  it('extracts name and description', () => {
    const parsed = parseFrontmatter('---\nname: nodejs\ndescription: Node patterns\n---\n# Body\n');
    expect(parsed).toEqual({ name: 'nodejs', description: 'Node patterns' });
  });

  it('returns empty object for missing or malformed frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\n')).toEqual({});
    expect(parseFrontmatter('---\nname: [unclosed\n---\nbody')).toEqual({});
  });

  it('ignores non-string fields', () => {
    expect(parseFrontmatter('---\nname: 42\ndescription: ok\n---\n')).toEqual({ description: 'ok' });
  });
});

describe('firstHeading', () => {
  it('returns the first markdown heading of the body', () => {
    expect(firstHeading('---\nfoo: bar\n---\nintro\n\n## Coding Style\n')).toBe('Coding Style');
    expect(firstHeading('# Top\n## Second\n')).toBe('Top');
    expect(firstHeading('no headings here')).toBeUndefined();
  });
});
