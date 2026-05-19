export const SITE = 'https://docxcorp.us';

export const routes = {
  home: () => '/',
  dataset: () => '/dataset',
  classification: () => '/classification',
  quality: () => '/quality',
  download: () => '/download',
  typesIndex: () => '/types',
  type: (id: string) => `/types/${id}`,
  topicsIndex: () => '/topics',
  topic: (id: string) => `/topics/${id}`,
} as const;

export function absoluteUrl(path: string): string {
  return `${SITE}${path}`;
}
