// @ts-check
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';

/**
 * public/audio/ holds symlinks to the local copies of each recording, purely
 * so `astro dev` can serve them with range requests while working offline.
 * Published audio lives on the Internet Archive, so it must never end up in
 * the deployed site — 52 MB per meeting would bloat every deploy for files
 * nothing links to.
 */
const excludeLocalAudio = {
  name: 'exclude-local-audio',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const target = new URL('audio/', dir);
      await rm(fileURLToPath(target), { recursive: true, force: true });
      logger.info('removed local dev audio from the build output');
    },
  },
};

export default defineConfig({
  // Custom domain on GitHub Pages, so the site serves from the root and
  // needs no `base` path. The CNAME file in public/ pairs with this.
  site: 'https://irvingtonmeetings.com',
  trailingSlash: 'never',
  build: {
    // Emit /slug.html rather than /slug/index.html so deep links stay clean.
    format: 'file',
  },
  compressHTML: true,
  integrations: [excludeLocalAudio],
});
