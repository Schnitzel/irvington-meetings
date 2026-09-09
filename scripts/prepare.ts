#!/usr/bin/env node --experimental-strip-types
/**
 * The owner's pipeline (brief §5).
 *
 *   npm run prepare-meeting -- \
 *     --input "~/Downloads/Compass Entertainment Complex.m4a" \
 *     --slug compass-entertainment-complex \
 *     --title "Compass Entertainment Complex" \
 *     --date 2026-08-14 \
 *     --body "Irvington Town Council"
 *
 * Takes a raw recording and produces a publishable content directory. Note
 * that the npm script is `prepare-meeting`, not `prepare`: npm treats a script
 * literally named `prepare` as a lifecycle hook and would run it on every
 * `npm install`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { compress, probeDuration, requireFfmpeg } from './lib/audio.ts';
import {
  identifierFor,
  itemExists,
  loadCredentials,
  uploadAudio,
  verifyRangeSupport,
} from './lib/archive.ts';
import { loadApiKey, loadKeyterms, transcribe } from './lib/deepgram.ts';
import { contentDir, formatBytes, formatDuration, normalizeSlug, RAW_FILE } from './lib/pipeline.ts';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    date: { type: 'string' },
    body: { type: 'string' },
    description: { type: 'string' },
    transcript: { type: 'string' },
    'no-compress': { type: 'boolean', default: false },
    'no-upload': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

function usage(): never {
  console.log(`
Usage: npm run prepare-meeting -- --input <file> --slug <slug> [options]

  --input <file>        The raw recording.
  --slug <slug>         Directory name under content/. Also the site URL.
  --title <title>       Meeting title.
  --date <YYYY-MM-DD>   Meeting date.
  --body <name>         The public body, e.g. "Irvington Town Council".
  --description <text>  One-line description for the index page.

  --transcript <file>   Use an existing SRT/VTT/Whisper JSON instead of
                        transcribing (skips Deepgram entirely).
  --no-compress         The input is already compressed; copy it as-is.
  --no-upload           Skip the Internet Archive upload.
  --force               Re-transcribe even if a cached response exists.
                        This costs money; normalization alone is free.
`);
  process.exit(1);
}

if (values.help || !values.slug) usage();

const slug = values.slug!;
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`✗ --slug must be lowercase letters, numbers and hyphens: got "${slug}"`);
  process.exit(1);
}
if (values.date && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
  console.error(`✗ --date must be YYYY-MM-DD: got "${values.date}"`);
  process.exit(1);
}

/** `~` is not expanded when an argument arrives quoted. */
const expand = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);

const dir = contentDir(slug);
const audioPath = join(dir, 'audio.m4a');

// --input may be omitted once a directory already holds its compressed audio,
// so the later steps (re-normalizing, uploading) can be re-run on their own.
if (!values.input && !values.transcript && !existsSync(audioPath)) {
  console.error(`✗ ${audioPath} does not exist, so --input is required.`);
  process.exit(1);
}
const rawPath = join(dir, RAW_FILE);
const keytermsPath = join(dir, 'keyterms.txt');

const step = (n: number, message: string) => console.log(`\n[${n}/6] ${message}`);

try {
  await mkdir(dir, { recursive: true });

  // --- 1. Compress -------------------------------------------------------
  let audioBytes = 0;
  if (values.input) {
    const input = expand(values.input);
    if (!existsSync(input)) throw new Error(`Input file not found: ${input}`);

    if (values['no-compress']) {
      step(1, 'Copying audio (--no-compress)');
      await writeFile(audioPath, await readFile(input));
      audioBytes = (await readFile(audioPath)).length;
    } else {
      step(1, 'Compressing to mono 64 kbps AAC');
      await requireFfmpeg();
      const source = await probeDuration(input);
      console.log(`      source: ${formatDuration(source)}`);
      ({ bytes: audioBytes } = await compress(input, audioPath));
    }
    console.log(`      ✓ ${audioPath} (${formatBytes(audioBytes)})`);
  } else if (existsSync(audioPath)) {
    audioBytes = (await readFile(audioPath)).length;
  }

  // --- 2 & 3. Transcribe, cached ----------------------------------------
  if (values.transcript) {
    step(2, `Using the supplied transcript (${values.transcript})`);
  } else if (existsSync(rawPath) && !values.force) {
    step(2, 'Skipping transcription — a cached response already exists');
    console.log('      Pass --force to re-transcribe. That costs money; renormalize is free.');
  } else {
    const keyterms = await loadKeyterms(keytermsPath);
    step(2, `Transcribing with Deepgram nova-3 (${keyterms.length} keyterms)`);
    if (keyterms.length === 0) {
      console.log(`      No ${keytermsPath}. Adding names and place names there and`);
      console.log('      re-running with --force noticeably improves accuracy.');
    }
    const apiKey = loadApiKey();
    const started = Date.now();
    const raw = await transcribe(apiKey, await readFile(audioPath), keyterms);
    await writeFile(rawPath, JSON.stringify(raw));
    console.log(`      ✓ cached to ${rawPath} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }

  // --- 4, 5, 6. Normalize, correct, scaffold ----------------------------
  step(4, 'Normalizing, applying corrections, scaffolding');
  const result = await normalizeSlug(slug, {
    transcriptPath: values.transcript ? expand(values.transcript) : undefined,
    audioBytes: audioBytes || undefined,
    metaDefaults: {
      title: values.title,
      date: values.date,
      body: values.body,
      description: values.description,
    },
  });
  console.log(
    `      ✓ ${result.paragraphs} paragraphs, ${result.words} words, ` +
      `${result.speakers.length} speakers, ${formatDuration(result.duration)}`,
  );
  for (const w of result.warnings) console.log(`      warning: ${w}`);

  // --- Publish the audio -------------------------------------------------
  if (values['no-upload']) {
    console.log('\n[6/6] Skipping the Internet Archive upload (--no-upload)');
  } else {
    const identifier = identifierFor(slug);
    step(6, `Publishing audio to the Internet Archive as ${identifier}`);

    if (await itemExists(identifier)) {
      console.log('      Item already exists — leaving it alone.');
    } else {
      const credentials = await loadCredentials();
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      console.log(`      Uploading ${formatBytes(audioBytes)}. This takes a few minutes.`);

      const url = await uploadAudio(credentials, {
        identifier,
        filename: 'audio.m4a',
        body: await readFile(audioPath),
        title: `${meta.title} — ${meta.body}, ${meta.date}`,
        description:
          `${meta.description || meta.title}\n\n` +
          `Audio recording of a public meeting of the ${meta.body}, ${meta.date}. ` +
          `Published by irvingtonmeetings.com, an independent volunteer archive.`,
        date: meta.date,
        creator: meta.body,
        subjects: ['Irvington', 'Virginia', 'public meeting', meta.body],
      });
      console.log(`      ✓ ${url}`);

      meta.archive.item = identifier;
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

      // Seeking a 52 MB file depends entirely on this (§9), so it is checked
      // rather than assumed.
      const range = await verifyRangeSupport(identifier, 'audio.m4a');
      console.log(
        range.ok
          ? `      ✓ range requests confirmed (${range.contentRange}, CORS ${range.cors})`
          : `      ⚠ expected HTTP 206, got ${range.status}. Scrubbing may be slow — ` +
            'the Archive may still be processing the upload; re-check in a few minutes.',
      );
    }
  }

  console.log(`\n✓ ${slug} is ready. Next:`);
  console.log(`  1. Put real names in ${join(dir, 'speakers.json')}`);
  console.log(`  2. Check the details in ${join(dir, 'meta.json')}`);
  console.log('  3. npm run dev');
} catch (error) {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
}
