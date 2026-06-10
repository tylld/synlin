/**
 * Canonical YAML frontmatter emitter. Deliberately tiny: converters emit a
 * fixed, ordered set of scalar fields (plus one level of string→string maps),
 * and output must be byte-deterministic — no dependence on js-yaml wrapping
 * behavior or key-order quirks.
 */

export type FrontmatterValue = string | boolean | ReadonlyArray<readonly [string, string]>;

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 ._/$*@()-]*$/;

function emitScalar(value: string): string {
  // Multiline strings are collapsed: frontmatter descriptions are one-liners by contract.
  const collapsed = value.replace(/\s*\n\s*/g, ' ').trim();
  if (collapsed !== '' && PLAIN_SCALAR.test(collapsed) && !collapsed.includes(': ') && collapsed === collapsed.trim()) {
    return collapsed;
  }
  return `"${collapsed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Emit a frontmatter document with the given fields in the given order. */
export function emitFrontmatter(fields: ReadonlyArray<readonly [string, FrontmatterValue | undefined]>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${emitScalar(value)}`);
    } else {
      lines.push(`${key}:`);
      for (const [subKey, subValue] of value) {
        lines.push(`  ${subKey}: ${emitScalar(subValue)}`);
      }
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/** Frontmatter + body, normalized to one trailing newline. */
export function withFrontmatter(fields: ReadonlyArray<readonly [string, FrontmatterValue | undefined]>, body: string): string {
  const cleanBody = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return cleanBody === '' ? emitFrontmatter(fields) : `${emitFrontmatter(fields)}\n${cleanBody}\n`;
}
