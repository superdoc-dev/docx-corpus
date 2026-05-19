import type { APIRoute } from 'astro';
import { absoluteUrl, routes } from '../lib/routes';
import { getTypeFacets, getTopicFacets } from '../lib/data';

export const GET: APIRoute = async () => {
  const [types, topics] = await Promise.all([getTypeFacets(), getTopicFacets()]);
  const today = new Date().toISOString().split('T')[0];

  const urls = [
    { loc: absoluteUrl(routes.home()), priority: '1.0' },
    { loc: absoluteUrl(routes.dataset()), priority: '0.9' },
    { loc: absoluteUrl(routes.classification()), priority: '0.9' },
    { loc: absoluteUrl(routes.quality()), priority: '0.9' },
    { loc: absoluteUrl(routes.download()), priority: '0.9' },
    { loc: absoluteUrl(routes.typesIndex()), priority: '0.8' },
    { loc: absoluteUrl(routes.topicsIndex()), priority: '0.8' },
    ...types.map(t => ({ loc: absoluteUrl(routes.type(t.id)), priority: '0.7' })),
    ...topics.map(t => ({ loc: absoluteUrl(routes.topic(t.id)), priority: '0.7' })),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(u =>
        `  <url><loc>${u.loc}</loc><changefreq>weekly</changefreq><priority>${u.priority}</priority><lastmod>${today}</lastmod></url>`
      )
      .join('\n') +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
