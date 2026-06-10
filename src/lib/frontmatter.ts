import matter from 'gray-matter';

export interface ParsedFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

/**
 * Extract name/description from YAML frontmatter.
 * Never throws: malformed YAML or non-string fields yield an empty result.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  try {
    const { data } = matter(content);
    return {
      ...(typeof data['name'] === 'string' ? { name: data['name'] } : {}),
      ...(typeof data['description'] === 'string' ? { description: data['description'] } : {}),
    };
  } catch {
    return {};
  }
}

/** First markdown heading in the body, used as a fallback description for rules. */
export function firstHeading(content: string): string | undefined {
  try {
    const { content: body } = matter(content);
    const match = body.match(/^#+\s+(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    const match = content.match(/^#+\s+(.+)$/m);
    return match?.[1]?.trim();
  }
}
