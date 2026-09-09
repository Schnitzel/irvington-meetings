/**
 * Owner-authored find/replace fixes (brief §5 step 5).
 *
 * Applied to the word stream rather than the finished text, so a correction
 * never desynchronises a word from its timing. A replacement spanning several
 * words inherits the timespan of the words it replaced.
 */

import type { SourceWord } from './schema.ts';

export interface Correction {
  /** The text to look for. Matched across word boundaries, case-insensitively. */
  find: string;
  replace: string;
  /** Set true to treat `find` as a regular expression. */
  regex?: boolean;
  /** Set true to require an exact case match. */
  caseSensitive?: boolean;
}

export interface CorrectionsFile {
  corrections: Correction[];
}

export interface CorrectionResult {
  words: SourceWord[];
  applied: Array<{ correction: Correction; count: number }>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies corrections to a word stream.
 *
 * Words are joined with single spaces, matched, and re-split. Because a match
 * can cover several words, we track which source words each match consumed and
 * spread the replacement's words across their combined timespan — the same
 * interpolation the SRT/VTT parsers use.
 */
export function applyCorrections(
  words: SourceWord[],
  corrections: Correction[],
): CorrectionResult {
  if (corrections.length === 0) return { words, applied: [] };

  let current = words;
  const applied: Array<{ correction: Correction; count: number }> = [];

  for (const correction of corrections) {
    // Offset of each word within the joined string, so a match's character
    // range can be mapped back to the words it covers.
    const offsets: number[] = [];
    let cursor = 0;
    for (const w of current) {
      offsets.push(cursor);
      cursor += w.text.length + 1;
    }
    const joined = current.map((w) => w.text).join(' ');

    const flags = correction.caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(
      correction.regex ? correction.find : escapeRegExp(correction.find),
      flags,
    );

    const matches = [...joined.matchAll(pattern)];
    if (matches.length === 0) {
      applied.push({ correction, count: 0 });
      continue;
    }

    const result: SourceWord[] = [];
    let nextWord = 0;

    for (const match of matches) {
      const from = match.index!;
      const to = from + match[0].length;

      // Words fully or partly covered by this match.
      let first = current.findIndex(
        (w, i) => offsets[i] + w.text.length > from && offsets[i] < to,
      );
      if (first === -1 || first < nextWord) continue;
      let last = first;
      while (last + 1 < current.length && offsets[last + 1] < to) last++;

      result.push(...current.slice(nextWord, first));

      const covered = current.slice(first, last + 1);
      const start = covered[0].start;
      const end = covered[covered.length - 1].end;
      const speaker = covered[0].speaker;

      const replacementText = correction.regex
        ? match[0].replace(pattern, correction.replace)
        : correction.replace;
      const pieces = replacementText.split(/\s+/).filter(Boolean);

      if (pieces.length > 0) {
        const step = (end - start) / pieces.length;
        result.push(
          ...pieces.map((text, i) => ({
            text,
            start: start + step * i,
            end: start + step * (i + 1),
            speaker,
          })),
        );
      }

      nextWord = last + 1;
    }

    result.push(...current.slice(nextWord));
    current = result;
    applied.push({ correction, count: matches.length });
  }

  return { words: current, applied };
}
