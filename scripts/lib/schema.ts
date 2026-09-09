/**
 * The normalized transcript schema (brief §6).
 *
 * This is the contract between the owner's pipeline and the published site.
 * The pipeline is the only thing that writes it; the player only reads it.
 * Every input format (Deepgram, SRT, VTT, Whisper JSON) collapses to this.
 */

export const SCHEMA_VERSION = 1;

/** A single word with its timing. `s`/`e` are seconds from the start of the audio. */
export interface Word {
  t: string;
  s: number;
  e: number;
}

export interface Paragraph {
  id: string;
  start: number;
  end: number;
  /** Stable opaque speaker id, e.g. "spk0". Display names come from speakers.json. */
  speaker: string;
  /** The joined word text, precomputed so the client never rebuilds it. */
  text: string;
  words: Word[];
}

export interface Transcript {
  version: number;
  duration: number;
  speakers: string[];
  paragraphs: Paragraph[];
}

/**
 * Paragraph grouping thresholds (§6). Tuned by eye against the Compass
 * recording: paragraphs that run long are hard to scan, and short ones make
 * the page read like captions rather than a document.
 */
export interface GroupingOptions {
  /** Silence that ends a paragraph, but only at a sentence boundary. */
  maxGapSeconds: number;
  /** Silence long enough to end a paragraph wherever the sentence landed. */
  hardGapSeconds: number;
  /** Break at the next sentence boundary once a paragraph passes this length. */
  maxChars: number;
}

export const DEFAULT_GROUPING: GroupingOptions = {
  maxGapSeconds: 2.2,
  hardGapSeconds: 4,
  maxChars: 450,
};

/** An intermediate word, before grouping. Every input parser produces these. */
export interface SourceWord {
  text: string;
  start: number;
  end: number;
  /** Diarized speaker index. Sources without diarization use 0 throughout. */
  speaker: number;
}

export function speakerId(index: number): string {
  return `spk${index}`;
}

/** Paragraph overlap beyond this many seconds is corruption, not crosstalk. */
export const OVERLAP_TOLERANCE = 0.5;

/**
 * Validates a transcript's internal consistency. Run at the end of the
 * pipeline so a malformed transcript fails on the owner's laptop rather than
 * silently producing a broken page for visitors.
 */
export function validate(t: Transcript): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (t.version !== SCHEMA_VERSION) {
    errors.push(`version is ${t.version}, expected ${SCHEMA_VERSION}`);
  }
  if (!(t.duration > 0)) {
    errors.push(`duration is ${t.duration}`);
  }
  if (t.paragraphs.length === 0) {
    errors.push('no paragraphs');
  }

  const seenIds = new Set<string>();
  let previousEnd = -Infinity;

  for (const [i, p] of t.paragraphs.entries()) {
    const where = `paragraph ${i} (${p.id})`;

    if (seenIds.has(p.id)) errors.push(`${where}: duplicate id`);
    seenIds.add(p.id);

    if (p.words.length === 0) {
      errors.push(`${where}: no words`);
      continue;
    }
    if (!t.speakers.includes(p.speaker)) {
      errors.push(`${where}: speaker ${p.speaker} missing from speakers list`);
    }
    if (p.start > p.end) {
      errors.push(`${where}: start ${p.start} after end ${p.end}`);
    }
    // Paragraphs must be in chronological order — the player's binary search
    // for the currently-playing paragraph depends on it. Small overlaps at
    // speaker changes are real crosstalk, not corruption, so they only warn.
    const overlap = previousEnd - p.start;
    if (overlap > 0.001) {
      const message = `${where}: starts ${overlap.toFixed(2)}s before the previous paragraph ended`;
      if (overlap > OVERLAP_TOLERANCE) errors.push(message);
      else warnings.push(message);
    }
    previousEnd = Math.max(previousEnd, p.end);

    if (p.text !== p.words.map((w) => w.t).join(' ')) {
      errors.push(`${where}: text does not match its words`);
    }
    if (p.start !== p.words[0].s) {
      errors.push(`${where}: start does not match its first word`);
    }
    if (p.end !== p.words[p.words.length - 1].e) {
      errors.push(`${where}: end does not match its last word`);
    }

    for (const [j, w] of p.words.entries()) {
      if (!(w.e >= w.s)) errors.push(`${where}, word ${j} ("${w.t}"): end before start`);
      if (j > 0 && w.s < p.words[j - 1].s - 0.001) {
        errors.push(`${where}, word ${j} ("${w.t}"): out of order`);
      }
    }
  }

  const last = t.paragraphs[t.paragraphs.length - 1];
  if (last && last.end > t.duration + 1) {
    errors.push(`last paragraph ends at ${last.end}, past the ${t.duration}s duration`);
  }

  return { errors, warnings };
}
