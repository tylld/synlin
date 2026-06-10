import matter from 'gray-matter';

/** Frontmatter-free body of a markdown document. Malformed YAML → original content. */
export function stripFrontmatter(content: string): string {
  try {
    return matter(content).content.replace(/^\n+/, '');
  } catch {
    return content;
  }
}

/** Raw frontmatter data of a markdown document. Malformed YAML → empty object. */
export function frontmatterData(content: string): Record<string, unknown> {
  try {
    return matter(content).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Demote every ATX heading by one level (#→##, capped at ######), skipping
 * lines inside fenced code blocks.
 */
export function shiftHeadingsDown(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      const fence = line.match(/^\s*(```|~~~)/);
      if (fence) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const heading = line.match(/^(#{1,6})(\s.*)$/);
      if (!heading || heading[1] === undefined || heading[2] === undefined) return line;
      const level = Math.min(heading[1].length + 1, 6);
      return `${'#'.repeat(level)}${heading[2]}`;
    })
    .join('\n');
}
