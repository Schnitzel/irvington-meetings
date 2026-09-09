/**
 * Fallback input formats (brief §6): SRT, VTT, and Whisper JSON, so the owner
 * can fall back to MacWhisper without changing anything downstream.
 *
 * SRT and VTT carry no word timings, so we interpolate across each cue by
 * character length. It is not exact, but it is well within the tolerance of
 * highlighting a word as it is spoken.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { SourceWord } from '../schema.ts';

export interface ParsedTranscript {
  words: SourceWord[];
  duration: number;
}

interface Cue {
  start: number;
  end: number;
  text: string;
  speaker: number;
}

/** Spreads a cue's words across its timespan, weighted by word length. */
function interpolateCue(cue: Cue): SourceWord[] {
  const pieces = cue.text.split(/\s+/).filter(Boolean);
  if (pieces.length === 0) return [];

  const span = Math.max(cue.end - cue.start, 0.001);
  const totalChars = pieces.reduce((sum, p) => sum + p.length, 0);

  const words: SourceWord[] = [];
  let cursor = cue.start;
  for (const text of pieces) {
    const share = (text.length / totalChars) * span;
    words.push({ text, start: cursor, end: cursor + share, speaker: cue.speaker });
    cursor += share;
  }
  // Absorb rounding drift into the final word so the cue ends where it should.
  words[words.length - 1].end = cue.end;
  return words;
}

/** Parses "00:01:02,345" (SRT) and "00:01:02.345" / "01:02.345" (VTT). */
function parseTimestamp(stamp: string): number {
  const parts = stamp.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Unparseable timestamp: "${stamp}"`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Some tools prefix cue text with a speaker label ("SPEAKER 1: ...", "<v Jane>").
 * When present we use it for diarization; otherwise everything is one speaker.
 */
const SPEAKER_PREFIX = /^(?:<v\s+([^>]+)>|(?:\[)?(?:SPEAKER|Speaker)[ _-]?(\d+|[A-Za-z ]+?)(?:\])?\s*:)\s*/;

function parseCueBlocks(body: string, isVtt: boolean): Cue[] {
  const cues: Cue[] = [];
  const speakerIndex = new Map<string, number>();

  for (const block of body.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    const timingLine = lines.findIndex((l) => l.includes('-->'));
    if (timingLine === -1) continue;

    const [from, to] = lines[timingLine].split('-->');
    // VTT allows cue settings after the end time ("... 00:02.000 line:90%").
    const start = parseTimestamp(from);
    const end = parseTimestamp(isVtt ? to.trim().split(/\s+/)[0] : to);

    let text = lines
      .slice(timingLine + 1)
      .join(' ')
      .replace(/<\/?(?!v\s)[^>]+>/g, '') // strip styling tags, keep <v Name>
      .trim();

    let speaker = 0;
    const match = text.match(SPEAKER_PREFIX);
    if (match) {
      const label = (match[1] ?? match[2]).trim();
      if (!speakerIndex.has(label)) speakerIndex.set(label, speakerIndex.size);
      speaker = speakerIndex.get(label)!;
      text = text.slice(match[0].length).replace(/<\/v>/g, '').trim();
    }

    if (text) cues.push({ start, end, text, speaker });
  }
  return cues;
}

export function parseSrt(source: string): ParsedTranscript {
  return cuesToTranscript(parseCueBlocks(source, false));
}

export function parseVtt(source: string): ParsedTranscript {
  const body = source.replace(/^﻿?WEBVTT[^\n]*\n/, '');
  return cuesToTranscript(parseCueBlocks(body, true));
}

function cuesToTranscript(cues: Cue[]): ParsedTranscript {
  if (cues.length === 0) throw new Error('No cues found — is this a valid SRT/VTT file?');
  const words = cues.flatMap(interpolateCue);
  return { words, duration: Math.max(...cues.map((c) => c.end)) };
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | number;
  words?: Array<{ word?: string; text?: string; start: number; end: number }>;
}

/**
 * Whisper JSON (OpenAI's format, which MacWhisper also emits). Uses real word
 * timings when the export includes them, and interpolates when it doesn't.
 */
export function parseWhisper(raw: unknown): ParsedTranscript {
  const data = raw as { segments?: WhisperSegment[]; duration?: number };
  const segments = data.segments;
  if (!segments?.length) throw new Error('Whisper JSON has no segments');

  const speakerIndex = new Map<string, number>();
  const speakerFor = (label: string | number | undefined): number => {
    if (label === undefined) return 0;
    const key = String(label);
    if (!speakerIndex.has(key)) speakerIndex.set(key, speakerIndex.size);
    return speakerIndex.get(key)!;
  };

  const words: SourceWord[] = [];
  for (const segment of segments) {
    const speaker = speakerFor(segment.speaker);

    if (segment.words?.length) {
      for (const w of segment.words) {
        const text = (w.word ?? w.text ?? '').trim();
        if (text) words.push({ text, start: w.start, end: w.end, speaker });
      }
    } else {
      words.push(
        ...interpolateCue({
          start: segment.start,
          end: segment.end,
          text: segment.text.trim(),
          speaker,
        }),
      );
    }
  }

  if (words.length === 0) throw new Error('Whisper JSON produced no words');
  return { words, duration: data.duration ?? words[words.length - 1].end };
}

export async function parseTranscriptFile(path: string): Promise<ParsedTranscript> {
  const source = await readFile(path, 'utf8');
  switch (extname(path).toLowerCase()) {
    case '.srt':
      return parseSrt(source);
    case '.vtt':
      return parseVtt(source);
    case '.json': {
      const raw = JSON.parse(source);
      // A cached Deepgram response is also valid input here.
      if (raw?.results?.channels) {
        const { parseDeepgram } = await import('./deepgram.ts');
        return parseDeepgram(raw);
      }
      return parseWhisper(raw);
    }
    default:
      throw new Error(`Unsupported transcript format: ${path} (expected .srt, .vtt, or .json)`);
  }
}
