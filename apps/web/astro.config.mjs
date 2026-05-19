import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://docxcorp.us',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
});
