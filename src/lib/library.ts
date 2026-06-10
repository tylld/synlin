import fs from 'node:fs';
import path from 'node:path';
import type { Category, ItemRef } from './categories.js';
import { isJunkFile, isValidItemName, itemId } from './categories.js';
import { firstHeading, parseFrontmatter } from './frontmatter.js';

export interface CatalogItem extends ItemRef {
  readonly id: string;
  /** Absolute path of the item inside the library (file, or directory for skills). */
  readonly sourcePath: string;
  readonly description?: string;
}

export interface Catalog {
  readonly items: readonly CatalogItem[];
  readonly warnings: readonly string[];
}

/**
 * The filesystem under libraryRoot IS the catalog — no registry file.
 * Invalid entries (skill dir without SKILL.md, malformed names) are
 * reported as warnings, never silently dropped.
 */
export function scanLibrary(libraryRoot: string): Catalog {
  const warnings: string[] = [];
  const items: CatalogItem[] = [
    ...scanSkills(libraryRoot, warnings),
    ...scanFlatMarkdown(libraryRoot, 'agents', warnings),
    ...scanFlatMarkdown(libraryRoot, 'commands', warnings),
    ...scanRules(libraryRoot, warnings),
    ...scanTemplates(libraryRoot, warnings),
  ];
  return { items: Object.freeze(items), warnings: Object.freeze(warnings) };
}

function listEntries(dir: string): fs.Dirent[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !isJunkFile(entry.name));
}

function makeItem(category: Category, name: string, sourcePath: string, description: string | undefined): CatalogItem {
  return {
    id: itemId({ category, name }),
    category,
    name,
    sourcePath,
    ...(description !== undefined ? { description } : {}),
  };
}

function scanSkills(libraryRoot: string, warnings: string[]): CatalogItem[] {
  const skillsDir = path.join(libraryRoot, 'skills');
  const items: CatalogItem[] = [];
  for (const entry of listEntries(skillsDir)) {
    if (!entry.isDirectory()) {
      warnings.push(`skills/${entry.name}: not a directory — skipped`);
      continue;
    }
    if (!isValidItemName('skills', entry.name)) {
      warnings.push(`skills/${entry.name}: invalid name — skipped`);
      continue;
    }
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      warnings.push(`skills/${entry.name}: missing SKILL.md — skipped`);
      continue;
    }
    const { description } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    items.push(makeItem('skills', entry.name, path.join(skillsDir, entry.name), description));
  }
  return items;
}

function scanFlatMarkdown(libraryRoot: string, category: 'agents' | 'commands', warnings: string[]): CatalogItem[] {
  const dir = path.join(libraryRoot, category);
  const items: CatalogItem[] = [];
  for (const entry of listEntries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      warnings.push(`${category}/${entry.name}: expected a .md file — skipped`);
      continue;
    }
    const name = entry.name.slice(0, -3);
    if (!isValidItemName(category, name)) {
      warnings.push(`${category}/${entry.name}: invalid name — skipped`);
      continue;
    }
    const sourcePath = path.join(dir, entry.name);
    const { description } = parseFrontmatter(fs.readFileSync(sourcePath, 'utf8'));
    items.push(makeItem(category, name, sourcePath, description));
  }
  return items;
}

function scanRules(libraryRoot: string, warnings: string[]): CatalogItem[] {
  const rulesDir = path.join(libraryRoot, 'rules');
  const items: CatalogItem[] = [];
  for (const entry of listEntries(rulesDir)) {
    if (entry.isDirectory()) {
      for (const ruleFile of listEntries(path.join(rulesDir, entry.name))) {
        const item = ruleItem(rulesDir, `${entry.name}/${ruleFile.name}`, ruleFile, warnings);
        if (item) items.push(item);
      }
    } else {
      const item = ruleItem(rulesDir, entry.name, entry, warnings);
      if (item) items.push(item);
    }
  }
  return items;
}

function ruleItem(rulesDir: string, relativePath: string, entry: fs.Dirent, warnings: string[]): CatalogItem | null {
  if (!entry.isFile() || !entry.name.endsWith('.md')) {
    warnings.push(`rules/${relativePath}: expected a .md file — skipped`);
    return null;
  }
  const name = relativePath.slice(0, -3);
  if (!isValidItemName('rules', name)) {
    warnings.push(`rules/${relativePath}: invalid name — skipped`);
    return null;
  }
  const sourcePath = path.join(rulesDir, relativePath);
  const description = firstHeading(fs.readFileSync(sourcePath, 'utf8'));
  return makeItem('rules', name, sourcePath, description);
}

function scanTemplates(libraryRoot: string, warnings: string[]): CatalogItem[] {
  const templatesDir = path.join(libraryRoot, 'templates');
  const items: CatalogItem[] = [];
  for (const entry of listEntries(templatesDir)) {
    if (!entry.isFile()) {
      warnings.push(`templates/${entry.name}: expected a file — skipped`);
      continue;
    }
    if (!isValidItemName('templates', entry.name)) {
      warnings.push(`templates/${entry.name}: invalid name — skipped`);
      continue;
    }
    items.push(
      makeItem('templates', entry.name, path.join(templatesDir, entry.name), `Copied to .claude/${entry.name} if absent`),
    );
  }
  return items;
}
