/**
 * Grouping a flat stream of timed words into readable paragraphs (brief §6).
 *
 * Deepgram returns its own `paragraphs`, but they are far too coarse to read:
 * on the Compass recording they averaged 31 seconds each and the first ran a
 * full 156 seconds. We regroup from the word stream instead, which also means
 * every input format goes through exactly one grouping implementation.
 */

import {
  DEFAULT_GROUPING,
  SCHEMA_VERSION,
  speakerId,
  type GroupingOptions,
  type Paragraph,
  type SourceWord,
  type Transcript,
  type Word,
} from './schema.ts';

/** Trailing punctuation that ends a sentence, ignoring closing quotes/brackets. */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

function endsSentence(text: string): boolean {
  // "Mr." / "St." / initials are sentence-shaped but aren't sentence ends.
  if (/^(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Ave|Rd|Jr|Sr|vs|etc|No)\.$/.test(text)) return false;
  return SENTENCE_END.test(text);
}

export function groupIntoParagraphs(
  words: SourceWord[],
  options: GroupingOptions = DEFAULT_GROUPING,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: SourceWord[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const w: Word[] = current.map((s) => ({ t: s.text, s: s.start, e: s.end }));
    paragraphs.push({
      id: `p${paragraphs.length}`,
      start: w[0].s,
      end: w[w.length - 1].e,
      speaker: speakerId(current[0].speaker),
      text: w.map((x) => x.t).join(' '),
      words: w,
    });
    current = [];
    currentChars = 0;
  };

  for (const [i, word] of words.entries()) {
    if (current.length > 0) {
      const previous = words[i - 1];
      const gap = word.start - previous.end;
      const atSentenceEnd = endsSentence(previous.text);

      const speakerChanged = word.speaker !== previous.speaker;
      // A pause only ends a paragraph if the speaker had actually finished a
      // sentence. Breaking on silence alone stranded fragments like
      // "Otherwise, it does become a" when someone paused mid-clause.
      const pausedAfterSentence = gap > options.maxGapSeconds && atSentenceEnd;
      // A long enough pause is a topic change regardless of where the
      // sentence landed — someone stopped, or the room moved on.
      const longSilence = gap > options.hardGapSeconds;
      // Only break on length at a sentence boundary, so paragraphs never end
      // mid-thought just because they got long.
      const longEnough = currentChars >= options.maxChars && atSentenceEnd;

      if (speakerChanged || pausedAfterSentence || longSilence || longEnough) flush();
    }

    current.push(word);
    currentChars += word.text.length + 1;
  }
  flush();

  return paragraphs;
}

export function buildTranscript(
  words: SourceWord[],
  duration: number,
  options: GroupingOptions = DEFAULT_GROUPING,
): Transcript {
  const paragraphs = groupIntoParagraphs(words, options);

  // Only speakers that actually say something get listed, and they are sorted
  // by index so the order is stable across re-runs.
  const speakers = [...new Set(paragraphs.map((p) => p.speaker))].sort(
    (a, b) => Number(a.slice(3)) - Number(b.slice(3)),
  );

  return { version: SCHEMA_VERSION, duration, speakers, paragraphs };
}
