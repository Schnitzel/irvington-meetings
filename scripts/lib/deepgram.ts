/**
 * Step 2 of the pipeline (§5): transcribe with Deepgram.
 *
 * The raw response is cached to disk by the caller and never re-fetched
 * unless forced, so normalization is free to re-run (§5 step 3).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const ENDPOINT = 'https://api.deepgram.com/v1/listen';

export function loadApiKey(): string {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error(
      'DEEPGRAM_API_KEY is not set.\n' +
        '  Put it in .env.local (which is gitignored) or export it in your shell.\n' +
        '  It is deliberately never accepted as a command-line flag.',
    );
  }
  return key;
}

/**
 * Keyterms are the highest-leverage accuracy lever Deepgram offers (§5), so
 * this file is meant to be edited and the transcription re-run: place names,
 * councilmember surnames, project names, zoning jargon.
 */
export async function loadKeyterms(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function buildUrl(keyterms: string[]): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    paragraphs: 'true',
    utterances: 'true',
    diarize: 'true',
  });
  for (const term of keyterms) params.append('keyterm', term);
  return `${ENDPOINT}?${params}`;
}

export async function transcribe(
  apiKey: string,
  audio: Buffer,
  keyterms: string[],
): Promise<unknown> {
  const response = await fetch(buildUrl(keyterms), {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/mp4',
    },
    body: audio,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`Deepgram returned HTTP ${response.status}: ${detail}`);
  }

  const raw = (await response.json()) as { err_code?: string; err_msg?: string };
  if (raw.err_code) throw new Error(`Deepgram error ${raw.err_code}: ${raw.err_msg ?? ''}`);
  return raw;
}
