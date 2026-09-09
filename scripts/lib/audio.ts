/**
 * Step 1 of the pipeline (§5): compress with ffmpeg.
 *
 * Mono AAC at 64 kbps. A two-hour meeting lands near 55 MB, which is small
 * enough to download on a rural connection and still perfectly clear for
 * speech — the Compass recording came out at 52 MB from a 103 MB original.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

function run(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
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
  const { code, stderr } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${path}: ${stderr.trim()}`);
  return Number(stderr.match(/[\d.]+/)?.[0] ?? 0) || 0;
}

export async function compress(input: string, output: string): Promise<{ bytes: number }> {
  const { code, stderr } = await run('ffmpeg', [
    '-y',
    '-i', input,
    '-vn',
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
