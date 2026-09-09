/**
 * Step 1 of the pipeline (§5): compress with ffmpeg.
 *
 * Mono AAC at 64 kbps. A two-hour meeting lands near 55 MB, which is small
 * enough to download on a rural connection and still perfectly clear for
 * speech — the Compass recording came out at 52 MB from a 103 MB original.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

function run(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    // ffmpeg reports progress on stderr, but ffprobe prints its answer on
    // stdout — capture both, or probeDuration silently returns 0.
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function requireFfmpeg(): Promise<void> {
  try {
    const { code } = await run('ffmpeg', ['-version']);
    if (code !== 0) throw new Error('ffmpeg exited non-zero');
  } catch {
    throw new Error(
      'ffmpeg is not installed, or not on your PATH.\n' +
        '  Install it with:  brew install ffmpeg\n' +
        '  Or pass --no-compress if your input is already a compressed mono file.',
    );
  }
}

export async function probeDuration(path: string): Promise<number> {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${stderr.trim()}`);

  const duration = Number(stdout.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe reported no usable duration for ${path}`);
  }
  return duration;
}

/*
 * Loudness normalization.
 *
 * The Compass recording swings widely in level: a facilitator near the
 * recorder, presenters further away, and audience questions further still.
 * Deepgram silently dropped roughly 45% of it — whole minutes came back with
 * no words at all, even though the audio there measured the same loudness as
 * passages that transcribed fine. Normalizing recovered most of it.
 *
 * dynaudnorm rather than loudnorm because it works in a moving window,
 * lifting quiet stretches instead of applying one gain to the whole file.
 */
const NORMALIZE_FILTER = 'dynaudnorm=f=250:g=15:p=0.9';

export async function compress(
  input: string,
  output: string,
  options: { normalize?: boolean } = {},
): Promise<{ bytes: number }> {
  const { code, stderr } = await run('ffmpeg', [
    '-y',
    '-i', input,
    '-vn',
    ...(options.normalize ? ['-af', NORMALIZE_FILTER] : []),
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', '64k',
    // Moves the index to the front of the file. Without this, seeking a
    // progressively-downloaded m4a stalls until the whole file arrives.
    '-movflags', '+faststart',
    output,
  ]);

  if (code !== 0) {
    throw new Error(`ffmpeg failed:\n${stderr.split('\n').slice(-12).join('\n')}`);
  }
  return { bytes: (await stat(output)).size };
}

/**
 * Extracts one window for chunked transcription.
 *
 * `pad` seconds of context are included on each side so the model does not
 * start or stop mid-word; the caller discards words outside the core window.
 */
export async function sliceAudio(
  input: string,
  output: string,
  start: number,
  duration: number,
  pad: number,
  options: { normalize?: boolean } = {},
): Promise<{ offset: number }> {
  const from = Math.max(0, start - pad);
  const { code, stderr } = await run('ffmpeg', [
    '-y',
    '-ss', String(from),
    '-t', String(duration + (start - from) + pad),
    '-i', input,
    '-vn',
    // Normalizing each window on its own matters more than the window size.
    // dynaudnorm's gain curve depends on the material it sees: computed over
    // the whole 110-minute file, loud passages hold the quiet ones down.
    // Recomputed per window it lifts them, which recovered 27% more words at
    // identical mean loudness (-15.0 dB either way).
    ...(options.normalize ? ['-af', NORMALIZE_FILTER] : []),
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', '64k',
    output,
  ]);

  if (code !== 0) {
    throw new Error(`ffmpeg slice failed:\n${stderr.split('\n').slice(-8).join('\n')}`);
  }
  // Timestamps in the slice are relative to `from`.
  return { offset: from };
}
