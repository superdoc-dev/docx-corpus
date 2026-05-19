import { SITE } from './routes';

export interface PageSeo {
  title: string;
  description: string;
  canonicalPath: string;
  ogImage?: string;
  robots?: string;
  structuredData?: object;
  breadcrumbs?: { name: string; path: string }[];
}

export function canonicalUrl(path: string): string {
  return `${SITE}${path}`;
}

export function breadcrumbList(items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: canonicalUrl(item.path),
    })),
  };
}

// Escape `</` in JSON-LD so structured data cannot close the script tag early.
export function stringifyLd(data: object): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}
