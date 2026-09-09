/**
 * Serves each normalized transcript as a static JSON file.
 *
 * The page's HTML already carries the readable transcript, so this exists only
 * to give the player word-level timings and the search index. It is fetched
 * after first paint (§9), which is why it isn't inlined into the document.
 */

import type { APIRoute, GetStaticPaths } from 'astro';

import { getMeetings } from '../../lib/content.ts';

export const getStaticPaths: GetStaticPaths = () =>
  getMeetings().map((meeting) => ({
    params: { slug: meeting.slug },
    props: { transcript: meeting.transcript },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(props.transcript), {
    headers: { 'Content-Type': 'application/json' },
  });
