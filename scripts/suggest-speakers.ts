#!/usr/bin/env node --experimental-strip-types
/**
 * npm run suggest-speakers -- --slug <slug> [--roster roster.txt] [--apply]
 *
 * Proposes a speakers.json by reading the roll call.
 *
 * Council meetings open with attendance, which is the one moment in a
 * recording where voices reliably attach to names. Two shapes occur:
 *
 *   self-announced   "Philip Robinson here."          -> the speaker is Philip
 *   clerk-called     "Mister Nunnally?" / "Here."     -> the *responder* is
 *
 * Public speakers usually introduce themselves before commenting, so the same
 * scan picks up "my name is ..." later in the meeting.
 *
 * Everything is a suggestion with the evidence printed beside it. Nothing is
 * written unless --apply is passed, and names already in speakers.json are
 * never overwritten — misattributing a person in a civic record is worse than
 * leaving them numbered.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { contentDir, formatDuration } from './lib/pipeline.ts';
import type { Transcript } from './lib/schema.ts';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    roster: { type: 'string' },
    apply: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.slug) {
  console.log(`
Usage: npm run suggest-speakers -- --slug <slug> [options]

  --roster <file>  Known names, one per line. Defaults to content/<slug>/keyterms.txt.
  --apply          Write the suggestions into speakers.json.
                   Existing names are never overwritten.
`);
  process.exit(values.help ? 0 : 1);
}

const slug = values.slug;
const dir = contentDir(slug);

/** Roll call happens at the top; anything later is a public speaker. */
const ROLL_CALL_WINDOW = 360;
const PRESENT = /\b(here|present)\b/i;

function looksLikeName(line: string): boolean {
  // Two or more capitalised words: a person, not "conditional use permit".
  return /^[A-Z][a-z'’.-]+(?: [A-Z][a-z'’.-]+)+$/.test(line.trim());
}

interface Suggestion {
  speaker: string;
  name: string;
  basis: string;
  quote: string;
  at: number;
  confidence: 'high' | 'medium';
}

try {
  const transcript = JSON.parse(
    await readFile(join(dir, 'transcript.json'), 'utf8'),
  ) as Transcript;

  const rosterPath = values.roster ?? join(dir, 'keyterms.txt');
  const roster = existsSync(rosterPath)
    ? (await readFile(rosterPath, 'utf8'))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && looksLikeName(l))
    : [];

  /*
   * keyterms.txt lists both "Samantha Van Saun" and "Van Saun" — the bare
   * surname is there to help the recogniser, but it must not win as a
   * display name. Drop any entry that is contained in a longer one.
   */
  const fullNames = roster.filter(
    (name) => !roster.some((other) => other !== name && other.endsWith(name)),
  );
  roster.length = 0;
  roster.push(...fullNames);

  if (roster.length === 0) {
    console.log(`No multi-word names found in ${rosterPath}; nothing to match against.`);
  }

  const suggestions: Suggestion[] = [];
  const paragraphs = transcript.paragraphs;

  /*
   * Diarization often collapses an entire roll call into one turn:
   * "Windsor Cline here. Frances Westbrook here. Bill Robinson here."
   * That is the clerk reading the roll with members answering, and every
   * name in it belongs to somebody else. Attributing any of them to that
   * voice would put the wrong name on a civic record, so such turns are
   * skipped for roll-call purposes entirely.
   */
  /** Every trailing portion of a name, longest first: "Van Saun", "Saun". */
  const variantsOf = (name: string) => {
    const parts = name.split(' ');
    return parts
      .map((_, i) => parts.slice(i).join(' '))
      .filter((v) => v.length > 2)
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  };
  const allVariants = roster.flatMap(variantsOf).join('|');

  /** How many "<name> here" pairs a turn contains. */
  const answerPairs = (text: string) =>
    allVariants
      ? (text.match(new RegExp(`\\b(?:${allVariants})\\s*,?\\s*(?:here|present)\\b`, 'gi')) ?? [])
          .length
      : 0;

  /** How many distinct roster people a turn mentions at all. */
  const namesIn = (text: string) =>
    roster.filter((n) => new RegExp(`\\b(?:${variantsOf(n).join('|')})\\b`, 'i').test(text)).length;

  for (const [i, p] of paragraphs.entries()) {
    /*
     * Diarization often merges a whole roll call into one turn, and every
     * name in such a turn belongs to someone else. Two shapes occur:
     *
     *   "Windsor Cline here. Frances Westbrook here. Bill Robinson here."
     *   "Frances Westbrook. Mary Windsor Cline. Mary Carrie Bradley."
     *
     * Both are rejected. But a genuine self-announcement often names other
     * people too — "Julie Harris here. Sam Van Saun is absent, and so far so
     * is mister Nunnally" — so counting names alone threw away good matches.
     * What separates them is how many "<name> here" pairs there are.
     */
    const pairs = answerPairs(p.text);
    const isRollCallRecital =
      p.start <= ROLL_CALL_WINDOW && (pairs >= 2 || (pairs === 0 && namesIn(p.text) >= 2));

    for (const name of roster) {
      /*
       * People answer the roll with whatever part of their name they use:
       * "Samantha Van Saun here", "Van Saun here", "Windsor Cline here".
       * Taking only the final word gave "Saun" and "Cline", which missed the
       * forms actually spoken — so try every trailing portion, longest first.
       */
      const parts = name.split(' ');
      const variants = parts
        .map((_, i) => parts.slice(i).join(' '))
        .filter((v) => v.length > 2);
      const alternation = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

      const pattern = new RegExp(`\\b(${alternation})\\b`, 'i');
      const found = pattern.exec(p.text);
      if (!found) continue;

      if (p.start <= ROLL_CALL_WINDOW && !isRollCallRecital) {
        /*
         * The name must open the turn and be followed immediately by the
         * answer. A looser window matched "Chapman, you here?" (someone
         * asking) and "the record show that mister Nunnally was tardy, but
         * he's present" (someone speaking about him) — both attributed a
         * voice to the wrong person.
         */
        /*
         * Either "Julie Harris here." or, where the chair asked for a roll
         * call by name, simply "Samantha Van Saun." — the whole turn being
         * one roster name is itself the answer. Safe because a turn holding
         * two or more names was already rejected above as a recital.
         */
        const selfAnnounced =
          new RegExp(
            `^\\s*(?:${alternation})\\s*[,.]?\\s*(?:is\\s+)?(?:here|present)\\b`,
            'i',
          ).test(p.text) ||
          /*
           * One leading word is allowed before the surname, because people
           * answer with the name they actually use: the roster says "Philip
           * Robinson" and the man says "Phil Robinson." Honorifics are
           * excluded — "Mister Nunnally." in the roll-call window is the
           * clerk calling him, not Nunnally answering.
           */
          new RegExp(
            `^\\s*(?!(?:mr|mister|mrs|missus|ms|miss|dr|mayor|councilman|councilwoman|councilmember)\\b)` +
              `(?:[A-Za-z][\\w'’-]*\\.?\\s+)?(?:${alternation})\\s*[.,!?]?\\s*$`,
            'i',
          ).test(p.text);

        if (selfAnnounced) {
          suggestions.push({
            speaker: p.speaker,
            name,
            basis: 'said their own name and answered the roll',
            quote: p.text.slice(Math.max(0, found.index - 20), found.index + 60),
            at: p.start,
            confidence: 'high',
          });
          continue;
        }
        // "Mister Nunnally?" — a call that ends on the name, answered by
        // someone else whose turn opens with the answer.
        const calledLast = new RegExp(`(?:${alternation})\\s*[?.]?\\s*$`, 'i').test(p.text);
        const next = paragraphs[i + 1];
        if (
          calledLast &&
          next &&
          next.speaker !== p.speaker &&
          /^\s*(?:here|present)\b/i.test(next.text)
        ) {
          suggestions.push({
            speaker: next.speaker,
            name,
            basis: 'answered when this name was called',
            quote: `${p.text.slice(-40)} | ${next.text.slice(0, 40)}`,
            at: next.start,
            confidence: 'medium',
          });
        }
      }
    }

    /*
     * Public speakers introduce themselves before commenting. This is not
     * restricted to after the roll call — public comment often opens the
     * meeting, and gating it on time missed "I'm Heather Sheehan and I am at
     * 90 Railway Road" two minutes in.
     */
    const intro = /\b(?:my name is|I am|I'm)\s+([A-Z][a-z'’-]+(?: [A-Z][a-z'’-]+){1,2})\b/.exec(p.text);
    /*
     * Only accept an introduction that is either a known roster name or a
     * plain two-word name. A looser rule published "Mary Carey Bradley",
     * which is nobody — it is the recogniser mangling "M.C. (Cay) Bradley".
     */
    const plausible =
      intro &&
      (roster.some((n) => n.toLowerCase() === intro[1].toLowerCase()) ||
        intro[1].split(' ').length === 2);
    if (intro && plausible && !isRollCallRecital) {
      suggestions.push({
        speaker: p.speaker,
        name: intro[1],
        basis: 'introduced themselves',
        quote: p.text.slice(Math.max(0, intro.index - 10), intro.index + 70),
        at: p.start,
        confidence: 'medium',
      });
    }
  }

  // Score each speaker/name pairing; the most-evidenced name wins.
  const tally = new Map<string, Map<string, { score: number; best: Suggestion }>>();
  for (const s of suggestions) {
    const forSpeaker = tally.get(s.speaker) ?? new Map();
    const entry = forSpeaker.get(s.name) ?? { score: 0, best: s };
    entry.score += s.confidence === 'high' ? 3 : 1;
    if (s.confidence === 'high' && entry.best.confidence !== 'high') entry.best = s;
    forSpeaker.set(s.name, entry);
    tally.set(s.speaker, forSpeaker);
  }

  const existing = existsSync(join(dir, 'speakers.json'))
    ? (JSON.parse(await readFile(join(dir, 'speakers.json'), 'utf8')) as Record<string, string>)
    : {};

  console.log(`\n${slug}\n`);
  const proposed: Record<string, string> = { ...existing };
  const claimed = new Set<string>();

  // Strongest evidence first, so one name is not attached to two voices.
  const ranked = [...tally.entries()]
    .map(([speaker, names]) => {
      const [name, entry] = [...names.entries()].sort((a, b) => b[1].score - a[1].score)[0];
      return { speaker, name, score: entry.score, best: entry.best };
    })
    .sort((a, b) => b.score - a.score);

  for (const r of ranked) {
    const already = existing[r.speaker];
    const isPlaceholder = !already || /^Speaker \d+$/.test(already);
    let note = '';

    if (claimed.has(r.name)) note = ' — SKIPPED, name already used';
    else if (!isPlaceholder) note = ` — kept existing "${already}"`;
    else {
      proposed[r.speaker] = r.name;
      claimed.add(r.name);
    }

    console.log(`  ${r.speaker} -> ${r.name}  (${r.best.confidence}, score ${r.score})${note}`);
    console.log(`      ${formatDuration(r.best.at)} ${r.best.basis}`);
    console.log(`      “…${r.best.quote.trim()}…”`);
  }

  const unresolved = transcript.speakers.filter(
    (id) => !proposed[id] || /^Speaker \d+$/.test(proposed[id]),
  );
  for (const [i, id] of transcript.speakers.entries()) {
    proposed[id] ??= `Speaker ${i + 1}`;
  }

  if (unresolved.length > 0) {
    console.log(`\n  unidentified, left numbered: ${unresolved.join(', ')}`);
  }

  if (values.apply) {
    await writeFile(join(dir, 'speakers.json'), JSON.stringify(proposed, null, 2) + '\n');
    console.log('\n  written to speakers.json — check it before publishing');
  } else {
    console.log('\n  (suggestions only; pass --apply to write them)');
  }
} catch (error) {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
}
