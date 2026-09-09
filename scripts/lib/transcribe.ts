/**
 * Chunked transcription.
 *
 * Deepgram silently dropped about 45% of the first Compass recording: whole
 * minutes came back with no words, in passages that measured the same
 * loudness as ones that transcribed perfectly. An 82-second clip cut from one
 * of those "empty" windows transcribed 72 words on its own.
 *
 * The cause is not request length, and it is not overall loudness. It is the
 * scope over which loudness is normalized. dynaudnorm's gain curve depends on
 * the material it sees: computed across a 110-minute meeting, the loud
 * passages hold the quiet ones down, and Deepgram then returns nothing for
 * the quiet ones. Recomputed per window, the quiet speech comes up.
 *
 *   chunk 5 (25:00-30:00)                     words
 *   sliced from the globally normalized file    299
 *   normalized as its own window                381   (1.27x, same -15.0 dB mean)
 *
 * So each chunk is cut from the original recording and normalized on its own,
 * rather than sliced out of an already-normalized file. Cost is unchanged:
 * Deepgram bills per minute of audio however it is split.
 *
 * The catch is diarization: speaker numbering is per-request, so chunk 3's
 * "speaker 1" has nothing to do with chunk 4's. We therefore also run one
 * whole-file pass purely for its speaker timeline, and assign each word from
 * the chunks to whichever speaker held the floor at that moment.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sliceAudio } from './audio.ts';
import { transcribe } from './deepgram.ts';

/** Long enough to keep context, short enough that quiet speech survives. */
export const CHUNK_SECONDS = 300;
/** Context included on each side, then discarded, so words are not clipped. */
export const CHUNK_PAD = 15;

/**
 * Stretches longer than this with no words at all get a second, harder
 * attempt. Most turn out to be audience questions asked away from the
 * recorder, which the first pass classifies as non-speech.
 */
export const GAP_RETRY_SECONDS = 10;
/** Don't bother re-attempting a gap longer than this; it really is a break. */
export const GAP_MAX_SECONDS = 240;

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface Utterance {
  start: number;
  end: number;
  speaker?: number;
}

function wordsOf(raw: any): DeepgramWord[] {
  return raw?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
}

/**
 * Who is speaking, when, from the whole-file pass. Chunk words are matched
 * against this so speaker identity stays consistent across the recording.
 */
function speakerTimeline(raw: any): Utterance[] {
  const utterances: Utterance[] = raw?.results?.utterances ?? [];
  if (utterances.length > 0) {
    return utterances.map((u) => ({ start: u.start, end: u.end, speaker: u.speaker ?? 0 }));
  }

  // Fall back to collapsing consecutive words by speaker.
  const segments: Utterance[] = [];
  for (const w of wordsOf(raw)) {
    const last = segments[segments.length - 1];
    if (last && last.speaker === (w.speaker ?? 0)) last.end = w.end;
    else segments.push({ start: w.start, end: w.end, speaker: w.speaker ?? 0 });
  }
  return segments;
}

function speakerAt(timeline: Utterance[], time: number): number {
  // Timeline is chronological; a binary search is plenty here.
  let low = 0;
  let high = timeline.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].start <= time) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return timeline[best]?.speaker ?? 0;
}

export interface ChunkedOptions {
  apiKey: string;
  /** The published audio, used for the whole-file diarization pass. */
  audioPath: string;
  /**
   * Where chunks are cut from — ideally the original recording, so each one
   * can be normalized on its own rather than inheriting the whole file's
   * gain curve. Falls back to audioPath.
   */
  sourceAudio?: string;
  duration: number;
  keyterms: string[];
  /** Directory for the individual chunk responses, kept for debugging. */
  cacheDir: string;
  onProgress?: (message: string) => void;
}

/**
 * Returns a Deepgram-shaped response so everything downstream — the parser,
 * the normalizer, renormalize — keeps working unchanged.
 */
/**
 * Re-attempts every stretch that came back with no words.
 *
 * Cheap, because it only pays for the silent stretches themselves, and it
 * targets exactly the content a civic transcript can least afford to lose:
 * residents asking questions. Words are appended in place, so a gap that
 * genuinely is a pause simply yields nothing.
 */
async function rescueGaps(options: {
  apiKey: string;
  source: string;
  words: DeepgramWord[];
  duration: number;
  keyterms: string[];
  cacheDir: string;
  timeline: Utterance[];
  say: (message: string) => void;
}): Promise<number> {
  const { apiKey, source, words, duration, keyterms, cacheDir, timeline, say } = options;

  const gaps: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < words.length; i++) {
    const start = words[i - 1].end;
    const end = words[i].start;
    const length = end - start;
    if (length >= GAP_RETRY_SECONDS && length <= GAP_MAX_SECONDS) gaps.push({ start, end });
  }
  // The recording may also start or end with an unheard stretch.
  if (words.length > 0) {
    if (words[0].start >= GAP_RETRY_SECONDS) gaps.unshift({ start: 0, end: words[0].start });
    const tail = duration - words[words.length - 1].end;
    if (tail >= GAP_RETRY_SECONDS && tail <= GAP_MAX_SECONDS) {
      gaps.push({ start: words[words.length - 1].end, end: duration });
    }
  }

  if (gaps.length === 0) return 0;
  const totalSeconds = gaps.reduce((sum, g) => sum + (g.end - g.start), 0);
  say(`second pass over ${gaps.length} silent stretches (${(totalSeconds / 60).toFixed(1)} min)…`);

  let recovered = 0;

  for (const [i, gap] of gaps.entries()) {
    const path = join(cacheDir, `gap-${String(i).padStart(3, '0')}.m4a`);
    // A couple of seconds either side, so a word straddling the edge is whole.
    const { offset } = await sliceAudio(source, path, gap.start, gap.end - gap.start, 2, {
      rescue: true,
    });

    let response: unknown;
    try {
      response = await transcribe(apiKey, await readFile(path), keyterms);
    } catch (error) {
      // One hard window is not worth failing the whole run over.
      say(`  gap at ${Math.floor(gap.start / 60)}min failed: ${(error as Error).message}`);
      continue;
    }

    const found = wordsOf(response)
      .map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))
      // Strictly inside the gap, so this never contradicts the first pass.
      .filter((w) => w.start >= gap.start && w.end <= gap.end)
      .map((w) => ({ ...w, speaker: speakerAt(timeline, w.start) }));

    if (found.length > 0) {
      words.push(...found);
      recovered += found.length;
    }
  }

  say(`  recovered ${recovered} words from ${gaps.length} stretches`);
  return recovered;
}

export async function transcribeChunked(options: ChunkedOptions): Promise<unknown> {
  const { apiKey, audioPath, duration, keyterms, cacheDir } = options;
  const say = options.onProgress ?? (() => {});

  await mkdir(cacheDir, { recursive: true });

  // --- One whole-file pass, for diarization only -------------------------
  say('whole-file pass for the speaker timeline…');
  const wholeFile = await transcribe(apiKey, await readFile(audioPath), keyterms);
  await writeFile(join(cacheDir, 'whole-file.json'), JSON.stringify(wholeFile));
  const timeline = speakerTimeline(wholeFile);
  say(`  ${timeline.length} speaker turns, ${new Set(timeline.map((t) => t.speaker)).size} voices`);

  // --- Chunked passes, for coverage --------------------------------------
  const total = Math.ceil(duration / CHUNK_SECONDS);
  const merged: DeepgramWord[] = [];

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SECONDS;
    const length = Math.min(CHUNK_SECONDS, duration - start);
    const slicePath = join(cacheDir, `chunk-${String(i).padStart(3, '0')}.m4a`);

    const { offset } = await sliceAudio(
      options.sourceAudio ?? audioPath,
      slicePath,
      start,
      length,
      CHUNK_PAD,
      { normalize: true },
    );
    const response = await transcribe(apiKey, await readFile(slicePath), keyterms);
    await writeFile(
      join(cacheDir, `chunk-${String(i).padStart(3, '0')}.json`),
      JSON.stringify(response),
    );

    // Shift into absolute time, then keep only this chunk's core window so
    // the padding never produces duplicates.
    const kept = wordsOf(response)
      .map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))
      .filter((w) => w.start >= start && w.start < start + length)
      .map((w) => ({ ...w, speaker: speakerAt(timeline, w.start) }));

    merged.push(...kept);
    say(
      `  chunk ${i + 1}/${total} (${Math.floor(start / 60)}:${String(Math.floor(start % 60)).padStart(2, '0')}) ` +
        `→ ${kept.length} words`,
    );
  }

  merged.sort((a, b) => a.start - b.start);

  // --- Second pass over whatever came back empty -------------------------
  const rescued = await rescueGaps({
    apiKey,
    source: options.sourceAudio ?? audioPath,
    words: merged,
    duration,
    keyterms,
    cacheDir,
    timeline,
    say,
  });
  if (rescued > 0) merged.sort((a, b) => a.start - b.start);

  const wholeFileWords = wordsOf(wholeFile).length;
  say(`whole-file pass: ${wholeFileWords} words; chunked: ${merged.length} words`);
  if (merged.length < wholeFileWords) {
    // Never publish a worse transcript than the simple approach would give.
    say('  chunking did not improve coverage — keeping the whole-file result');
    return wholeFile;
  }

  return {
    metadata: { duration, chunked: true, chunks: total },
    results: {
      channels: [{ alternatives: [{ words: merged }] }],
      utterances: timeline,
    },
  };
}
