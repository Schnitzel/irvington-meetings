/**
 * Loads .env.local before anything reads process.env.
 *
 * The README told people to put DEEPGRAM_API_KEY here, but nothing actually
 * read the file — a re-transcription failed with "DEEPGRAM_API_KEY is not
 * set" despite the key being exactly where the docs said to put it.
 */

import { existsSync } from 'node:fs';

const ENV_FILES = ['.env.local', '.env'];

export function loadEnv(): void {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    try {
      // Values already in the environment win, so an explicit
      // `DEEPGRAM_API_KEY=… npm run …` still overrides the file.
      process.loadEnvFile(file);
    } catch (error) {
      console.warn(`  warning: could not read ${file}: ${(error as Error).message}`);
    }
  }
}
