/**
 * Publishing audio to the Internet Archive.
 *
 * The site is hosted on GitHub Pages, which is a poor place for 50 MB media
 * files, and the Archive gives the recordings a permanent home independent of
 * this site (§12). Its download endpoints answer HTTP 206 range requests with
 * `Access-Control-Allow-Origin: *`, which is what makes scrubbing work (§9).
 *
 * Uses the IAS3 interface, which is a plain authenticated PUT.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const S3_ENDPOINT = 'https://s3.us.archive.org';
const KEYS_FILE = join(homedir(), '.archive-org-keys');

export interface ArchiveCredentials {
  accessKey: string;
  secretKey: string;
}

/**
 * Credentials come from the environment first, then ~/.archive-org-keys.
 * They are never read from a command-line flag and never committed.
 */
export async function loadCredentials(): Promise<ArchiveCredentials> {
  let accessKey = process.env.ARCHIVE_ORG_S3_ACCESS_KEY;
  let secretKey = process.env.ARCHIVE_ORG_S3_SECRET_KEY;

  if ((!accessKey || !secretKey) && existsSync(KEYS_FILE)) {
    for (const line of (await readFile(KEYS_FILE, 'utf8')).split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"\s]+)"?\s*$/);
      if (!match) continue;
      if (match[1] === 'ARCHIVE_ORG_S3_ACCESS_KEY') accessKey ??= match[2];
      if (match[1] === 'ARCHIVE_ORG_S3_SECRET_KEY') secretKey ??= match[2];
    }
  }

  if (!accessKey || !secretKey) {
    throw new Error(
      'No Internet Archive credentials. Set ARCHIVE_ORG_S3_ACCESS_KEY and ' +
        `ARCHIVE_ORG_S3_SECRET_KEY, or put them in ${KEYS_FILE}. ` +
        'Generate them at https://archive.org/account/s3.php',
    );
  }
  return { accessKey, secretKey };
}

/** Archive identifiers are global, so ours are namespaced to this project. */
export function identifierFor(slug: string): string {
  return `irvington-meetings-${slug}`;
}

/** Metadata headers must be ASCII; anything else goes through uri(). */
function metaHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `uri(${encodeURIComponent(value)})`;
}

export async function itemExists(identifier: string): Promise<boolean> {
  const response = await fetch(`https://archive.org/metadata/${identifier}`);
  if (!response.ok) return false;
  const data = (await response.json()) as { files?: unknown[] };
  return Array.isArray(data.files) && data.files.length > 0;
}

export interface UploadOptions {
  identifier: string;
  filename: string;
  body: Buffer;
  title: string;
  description: string;
  /** Meeting date, YYYY-MM-DD. */
  date: string;
  creator: string;
  subjects: string[];
}

/**
 * Uploads one file, creating the item if it does not exist.
 *
 * Note that the Archive derives alternate formats asynchronously afterwards;
 * the original is downloadable almost immediately, but the item page can take
 * a few minutes to look finished.
 */
export async function uploadAudio(
  credentials: ArchiveCredentials,
  options: UploadOptions,
): Promise<string> {
  const url = `${S3_ENDPOINT}/${options.identifier}/${options.filename}`;

  const headers: Record<string, string> = {
    authorization: `LOW ${credentials.accessKey}:${credentials.secretKey}`,
    'content-type': 'audio/mp4',
    'x-archive-auto-make-bucket': '1',
    // Community audio: the right home for civic recordings.
    'x-archive-meta-collection': 'opensource_audio',
    'x-archive-meta-mediatype': 'audio',
    'x-archive-meta-title': metaHeader(options.title),
    'x-archive-meta-description': metaHeader(options.description),
    'x-archive-meta-date': options.date,
    'x-archive-meta-creator': metaHeader(options.creator),
    'x-archive-meta-language': 'eng',
    // Public records of a public meeting.
    'x-archive-meta-licenseurl': 'https://creativecommons.org/publicdomain/mark/1.0/',
  };

  for (const [i, subject] of options.subjects.entries()) {
    headers[`x-archive-meta${i + 1}-subject`] = metaHeader(subject);
  }

  const response = await fetch(url, { method: 'PUT', headers, body: options.body });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(
      `Internet Archive upload failed: HTTP ${response.status} ${response.statusText}\n${detail}`,
    );
  }

  return `https://archive.org/details/${options.identifier}`;
}

/**
 * Confirms the uploaded file is reachable and that the host honours range
 * requests — the single most likely thing to silently break (§9).
 */
export async function verifyRangeSupport(
  identifier: string,
  filename: string,
): Promise<{ ok: boolean; status: number; contentRange: string | null; cors: string | null }> {
  const response = await fetch(`https://archive.org/download/${identifier}/${filename}`, {
    headers: { Range: 'bytes=1000-1999' },
  });
  // Drain the body so the connection can be reused.
  await response.arrayBuffer().catch(() => undefined);

  return {
    ok: response.status === 206,
    status: response.status,
    contentRange: response.headers.get('content-range'),
    cors: response.headers.get('access-control-allow-origin'),
  };
}
