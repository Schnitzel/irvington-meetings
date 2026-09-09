#!/usr/bin/env node --experimental-strip-types
/**
 * npm run probe-gaps -- --slug <slug>
 *
 * Asks a more permissive model what is in the stretches the main transcript
 * left empty, and writes the answers into the cached response so the page can
 * show them as best-effort text beside each gap marker.
 *
 * Separate from `prepare-meeting` because it is cheap (it only pays for the
 * silent stretches) and worth re-running on its own after the transcript
 * changes, without paying for a full re-transcription.
 *
 * The text it produces is explicitly unreliable — see transcribeUncertain —
 * so it is stored and rendered as an aid to listening, never as a record.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { sliceAudio } from './lib/audio.ts';
import { loadApiKey, transcribeUncertain } from './lib/deepgram.ts';
import { loadEnv } from './lib/env.ts';
import { contentDir, formatDuration, normalizeSlug, RAW_FILE } from './lib/pipeline.ts';
import type { Gap, Transcript } from './lib/schema.ts';

loadEnv();

const { values } = parseArgs({
  options: { slug: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

if (values.help || !values.slug) {
  console.log('\nUsage: npm run probe-gaps -- --slug <slug>\n');
  process.exit(values.help ? 0 : 1);
}

const slug = values.slug;
const dir = contentDir(slug);
const rawPath = join(dir, RAW_FILE);
const audioPath = join(dir, 'audio.m4a');
const cacheDir = join(dir, '.deepgram-chunks');

try {
  if (!existsSync(rawPath)) throw new Error(`No cached transcription at ${rawPath}`);
  if (!existsSync(audioPath)) throw new Error(`No audio at ${audioPath}`);

  const transcript = JSON.parse(
    await readFile(join(dir, 'transcript.json'), 'utf8'),
  ) as Transcript;
  const gaps = transcript.gaps ?? [];

  if (gaps.length === 0) {
    console.log('No gaps to probe.');
    process.exit(0);
  }

  const totalSeconds = gaps.reduce((sum, g) => sum + (g.end - g.start), 0);
  console.log(
    `Probing ${gaps.length} gaps (${(totalSeconds / 60).toFixed(1)} min) for ${slug}…`,
  );

  const apiKey = loadApiKey();
  await mkdir(cacheDir, { recursive: true });

  const probed: Gap[] = [];
  let described = 0;

  for (const [i, gap] of gaps.entries()) {
    const path = join(cacheDir, `probe-${String(i).padStart(3, '0')}.m4a`);
    let text = '';
    try {
      await sliceAudio(audioPath, path, gap.start, gap.end - gap.start, 1, { rescue: true });
      text = await transcribeUncertain(apiKey, await readFile(path));
    } catch (error) {
      console.log(`  ${formatDuration(gap.start)}: ${(error as Error).message}`);
    }

    probed.push(text ? { ...gap, text } : { start: gap.start, end: gap.end });
    if (text) described++;
    console.log(
      `  ${formatDuration(gap.start)}-${formatDuration(gap.end)} ` +
        `(${Math.round(gap.end - gap.start)}s): ${text ? `${text.split(/\s+/).length} words` : 'nothing audible'}`,
    );
  }

  // Store alongside the cached response so renormalize picks them up.
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  raw.results ??= {};
  raw.results.gaps = probed;
  await writeFile(rawPath, JSON.stringify(raw));

  const result = await normalizeSlug(slug);
  console.log(
    `\n✓ ${described} of ${gaps.length} gaps have best-effort text ` +
      `(${result.gaps} marked on the page)`,
  );
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
}
