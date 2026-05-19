/**
 * Content loader for markdown drafts in apps/site/content/.
 *
 * Each .md file has YAML frontmatter parsed by Astro's import.meta.glob.
 * The body is rendered to HTML at build time.
 */

export interface ContentFrontmatter {
  title: string;
  description: string;
  canonicalPath: string;
  status: 'draft' | 'published';
  lastVerified: string;
  primaryQuery: string;
  secondaryQueries?: string[];
}

export interface ContentEntry {
  frontmatter: ContentFrontmatter;
  Content: unknown;
  rawContent: () => string;
  compiledContent: () => string;
  file: string;
  url: string | undefined;
}
