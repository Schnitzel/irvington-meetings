/**
 * Deepgram pre-recorded response -> SourceWord[].
 *
 * We read only the word stream. Deepgram's `paragraphs` and `utterances` are
 * ignored on purpose: our own grouping rule (§6) produces something far more
 * readable, and going through the word stream keeps every input format on one
 * code path.
 */

import type { Gap, SourceWord } from '../schema.ts';

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ alternatives?: Array<{ words?: DeepgramWord[] }> }>;
    gaps?: Gap[];
  };
}

export function parseDeepgram(raw: DeepgramResponse): {
  words: SourceWord[];
  duration: number;
  gaps: Gap[];
} {
  const words = raw.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!words?.length) {
    throw new Error(
      'Deepgram response contains no words. The cached response may be an ' +
        'error payload — delete .deepgram-raw.json and re-run with --force.',
    );
  }

  const duration = raw.metadata?.duration;
  if (!duration) throw new Error('Deepgram response is missing metadata.duration');

  return {
    duration,
    gaps: raw.results?.gaps ?? [],
    words: words.map((w) => ({
      text: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      // Without diarize=true every word lands in a single speaker bucket.
      speaker: w.speaker ?? 0,
    })),
  };
}
