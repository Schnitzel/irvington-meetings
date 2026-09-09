/**
 * Steps 4-6 of the pipeline (brief §5): normalize, correct, scaffold.
 *
 * Kept separate from the CLI so `renormalize` can redo exactly this work from
 * the cached raw response without touching ffmpeg, Deepgram, or the network.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { applyCorrections, type CorrectionsFile } from './corrections.ts';
import { buildTranscript } from './normalize.ts';
import { parseDeepgram } from './parsers/deepgram.ts';
import { parseTranscriptFile } from './parsers/index.ts';
import { DEFAULT_GROUPING, validate, type Gap, type SourceWord } from './schema.ts';

export const CONTENT_ROOT = 'content';
export const RAW_FILE = '.deepgram-raw.json';

export interface AgendaItem {
  label: string;
  start: number;
}

export interface Meta {
  title: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /**
   * What kind of gathering this was, e.g. "Irvington Town Council" or
   * "Public information meeting". Not every recording is a formal body:
   * the first one was residents being presented to, not a council session.
   */
  body: string;
  description: string;
  /** Who presented, when the meeting was a presentation rather than a session. */
  presenters?: string[];
  /** Hand-authored chapter markers. Optional. */
  agenda: AgendaItem[];
  /** Internet Archive item that hosts the audio. */
  archive: { item: string | null; file: string };
  audio: { bytes: number; duration: number };
  /** Optional agenda packet or supporting document. */
  packet: { label: string; url: string } | null;
}

export function contentDir(slug: string): string {
  return join(CONTENT_ROOT, slug);
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await writeFile(path, pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value));
}

export interface NormalizeResult {
  gaps: number;
  gapsDescribed: number;
  paragraphs: number;
  speakers: string[];
  words: number;
  duration: number;
  warnings: string[];
  correctionsApplied: Array<{ find: string; count: number }>;
  scaffolded: string[];
}

/**
 * Steps 4-6 for one slug. Reads whatever source transcript the directory
 * holds, writes transcript.json, and scaffolds meta.json / speakers.json
 * without ever overwriting values the owner has already filled in by hand.
 */
export async function normalizeSlug(
  slug: string,
  options: {
    /** An external transcript (SRT/VTT/Whisper JSON) instead of the cached Deepgram response. */
    transcriptPath?: string;
    /** Values for a freshly scaffolded meta.json. */
    metaDefaults?: Partial<Meta>;
    audioBytes?: number;
  } = {},
): Promise<NormalizeResult> {
  const dir = contentDir(slug);
  const scaffolded: string[] = [];

  // --- Step 4: normalize -------------------------------------------------
  let words: SourceWord[];
  let duration: number;
  let probedGaps: Gap[] = [];

  if (options.transcriptPath) {
    ({ words, duration } = await parseTranscriptFile(options.transcriptPath));
  } else {
    const rawPath = join(dir, RAW_FILE);
    if (!existsSync(rawPath)) {
      throw new Error(
        `No cached transcription at ${rawPath}. Run \`npm run prepare-meeting\` first, ` +
          `or pass --transcript with an SRT/VTT/Whisper file.`,
      );
    }
    ({ words, duration, gaps: probedGaps } = parseDeepgram(
      JSON.parse(await readFile(rawPath, 'utf8')),
    ));
  }

  // --- Step 5: corrections ----------------------------------------------
  const correctionsFile = await readJsonIfPresent<CorrectionsFile>(
    join(dir, 'corrections.json'),
  );
  const { words: corrected, applied } = applyCorrections(
    words,
    correctionsFile?.corrections ?? [],
  );

  const transcript = buildTranscript(corrected, duration, DEFAULT_GROUPING, probedGaps);

  const { errors, warnings } = validate(transcript);
  if (errors.length > 0) {
    throw new Error(`Transcript failed validation:\n  - ${errors.join('\n  - ')}`);
  }

  // Minified: this is the largest file a visitor downloads, and nothing reads
  // it by hand.
  await writeJson(join(dir, 'transcript.json'), transcript, false);

  // --- Step 6: scaffold --------------------------------------------------
  const speakersPath = join(dir, 'speakers.json');
  const existingSpeakers = (await readJsonIfPresent<Record<string, string>>(speakersPath)) ?? {};
  const speakers: Record<string, string> = {};
  for (const [i, id] of transcript.speakers.entries()) {
    // Never clobber a name the owner has already written.
    speakers[id] = existingSpeakers[id] ?? `Speaker ${i + 1}`;
  }
  await writeJson(speakersPath, speakers);
  if (Object.keys(existingSpeakers).length === 0) scaffolded.push('speakers.json');

  const metaPath = join(dir, 'meta.json');
  const existingMeta = await readJsonIfPresent<Meta>(metaPath);
  if (!existingMeta) {
    const meta: Meta = {
      title: options.metaDefaults?.title ?? slug,
      date: options.metaDefaults?.date ?? new Date().toISOString().slice(0, 10),
      body: options.metaDefaults?.body ?? '',
      description: options.metaDefaults?.description ?? '',
      presenters: [],
      agenda: [],
      archive: { item: options.metaDefaults?.archive?.item ?? null, file: 'audio.m4a' },
      audio: { bytes: options.audioBytes ?? 0, duration },
      packet: null,
    };
    await writeJson(metaPath, meta);
    scaffolded.push('meta.json');
  } else {
    // Duration always reflects the transcript we just built; the rest is the
    // owner's to edit.
    existingMeta.audio.duration = duration;
    if (options.audioBytes) existingMeta.audio.bytes = options.audioBytes;
    await writeJson(metaPath, existingMeta);
  }

  return {
    gaps: transcript.gaps?.length ?? 0,
    gapsDescribed: transcript.gaps?.filter((g) => g.text).length ?? 0,
    paragraphs: transcript.paragraphs.length,
    speakers: transcript.speakers,
    words: corrected.length,
    duration,
    warnings,
    correctionsApplied: applied.map((a) => ({ find: a.correction.find, count: a.count })),
    scaffolded,
  };
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return 'unknown size';
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export { basename };
