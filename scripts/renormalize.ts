#!/usr/bin/env node --experimental-strip-types
/**
 * npm run renormalize -- --slug <slug> [--transcript <file.srt|vtt|json>]
 *
 * Redoes steps 4-6 from the cached raw response (brief §5). No ffmpeg, no
 * network, no Deepgram charge — so fixing a typo in corrections.json costs
 * nothing and takes about a second.
 */

import { parseArgs } from 'node:util';

import { loadEnv } from './lib/env.ts';
import { formatDuration, normalizeSlug } from './lib/pipeline.ts';

loadEnv();

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    transcript: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.slug) {
  console.log(`
Usage: npm run renormalize -- --slug <slug> [options]

  --slug <slug>          Content directory under content/ to renormalize.
  --transcript <file>    Use an external SRT/VTT/Whisper JSON instead of the
                         cached Deepgram response.
`);
  process.exit(values.help ? 0 : 1);
}

const started = Date.now();

try {
  const result = await normalizeSlug(values.slug, { transcriptPath: values.transcript });

  console.log(`✓ ${values.slug}`);
  console.log(
    `  ${result.paragraphs} paragraphs, ${result.words} words, ` +
      `${result.speakers.length} speakers, ${formatDuration(result.duration)}`,
  );

  for (const c of result.correctionsApplied) {
    const label = c.count === 0 ? 'no matches' : `${c.count} replaced`;
    console.log(`  correction "${c.find}": ${label}`);
  }
  if (result.gaps > 0) {
    console.log(
      `  ${result.gaps} gaps marked for readers, ${result.gapsDescribed} with best-effort text`,
    );
  }
  for (const w of result.warnings) {
    console.log(`  warning: ${w}`);
  }
  if (result.scaffolded.length > 0) {
    console.log(`  scaffolded ${result.scaffolded.join(', ')} — fill in speaker names by hand`);
  }

  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
}
