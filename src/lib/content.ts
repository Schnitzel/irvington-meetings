/**
 * Build-time content loading.
 *
 * Each recording is a directory under content/ (brief §4). Adding a meeting
 * means adding a directory and rebuilding — that is the whole content model.
 * Nothing here runs in the browser.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Meta } from '../../scripts/lib/pipeline.ts';
import type { Transcript } from '../../scripts/lib/schema.ts';

const CONTENT_ROOT = 'content';

export interface Meeting {
  slug: string;
  meta: Meta;
  /** Speaker id -> display name, baked in at build time (§3). */
  speakers: Record<string, string>;
  transcript: Transcript;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

let cache: Meeting[] | null = null;

/** Every published recording, newest first (§7). */
export function getMeetings(): Meeting[] {
  if (cache) return cache;

  if (!existsSync(CONTENT_ROOT)) return (cache = []);

  const meetings: Meeting[] = [];

  for (const slug of readdirSync(CONTENT_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)) {
    const dir = join(CONTENT_ROOT, slug);
    const metaPath = join(dir, 'meta.json');
    const transcriptPath = join(dir, 'transcript.json');

    // A directory mid-pipeline (audio compressed, not yet normalized) is
    // skipped rather than breaking the build.
    if (!existsSync(metaPath) || !existsSync(transcriptPath)) {
      console.warn(`[content] skipping ${slug}: missing meta.json or transcript.json`);
      continue;
    }

    const speakersPath = join(dir, 'speakers.json');
    meetings.push({
      slug,
      meta: readJson<Meta>(metaPath),
      speakers: existsSync(speakersPath) ? readJson<Record<string, string>>(speakersPath) : {},
      transcript: readJson<Transcript>(transcriptPath),
    });
  }

  meetings.sort((a, b) => b.meta.date.localeCompare(a.meta.date));
  return (cache = meetings);
}

export function getMeeting(slug: string): Meeting | undefined {
  return getMeetings().find((m) => m.slug === slug);
}

/** Display name for a speaker id, falling back to the raw id. */
export function speakerName(meeting: Meeting, id: string): string {
  return meeting.speakers[id] ?? id;
}

/**
 * The public URL of the audio.
 *
 * Published audio lives on the Internet Archive, which serves HTTP 206 range
 * requests with permissive CORS — verified before this was chosen, since
 * seeking a 52 MB file depends on it entirely (§9). Before an item is
 * uploaded we fall back to a local file so the site is usable offline.
 */
export function audioUrl(meeting: Meeting): string {
  const { item, file } = meeting.meta.archive;
  return item
    ? `https://archive.org/download/${item}/${file}`
    : `/audio/${meeting.slug}.m4a`;
}

/** The human-facing Internet Archive item page, for the mirror link (§12). */
export function archiveUrl(meeting: Meeting): string | null {
  return meeting.meta.archive.item
    ? `https://archive.org/details/${meeting.meta.archive.item}`
    : null;
}

export function transcriptUrl(slug: string): string {
  return `/transcripts/${slug}.json`;
}

export function formatDate(iso: string): string {
  // Parsed as UTC to avoid a local timezone shifting the date backwards.
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Spoken-language duration for screen readers and the index listing. */
export function describeDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m === 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  return `${Math.round(bytes / 1_000_000)} MB`;
}
