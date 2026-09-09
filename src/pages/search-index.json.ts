/**
 * The site-wide search index (brief §7).
 *
 * One static JSON file scanned in the browser. For fewer than ~50 meetings
 * this beats a hosted search service on every axis that matters here: no
 * runtime dependency, no cost, no privacy surface, and it keeps working if
 * the project is left alone for years.
 *
 * It is fetched only when someone actually types a search, so the index page
 * stays fast for the majority who never do.
 */

import type { APIRoute } from 'astro';

import { getMeetings } from '../lib/content.ts';

export const GET: APIRoute = () => {
  const index = getMeetings().map((meeting) => ({
    slug: meeting.slug,
    title: meeting.meta.title,
    body: meeting.meta.body,
    date: meeting.meta.date,
    // Only what a result needs: the text to match and the moment to link to.
    p: meeting.transcript.paragraphs.map((p) => [
      Math.round(p.start * 100) / 100,
      p.text,
      meeting.speakers[p.speaker] ?? p.speaker,
    ]),
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  });
};
