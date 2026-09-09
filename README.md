# Irvington Meetings

Recordings of public meetings in Irvington, Virginia, published with
synchronised, searchable transcripts. An independent volunteer archive — not
affiliated with the Town of Irvington.

Live at **[irvingtonmeetings.com](https://irvingtonmeetings.com)**.

## How it works

Two cleanly separated halves:

- **A content pipeline** that runs on the owner's laptop (`scripts/`). It
  compresses audio, transcribes it, normalizes the transcript, and publishes
  the audio to the Internet Archive.
- **A static site** (`src/`) that knows nothing about any of that. It reads
  prepared JSON out of `content/` and builds plain HTML, CSS and JS.

Visitors never upload anything. There is no login, no account, no server-side
processing, and no database. A visitor's browser only ever fetches static
files.

### Where things live

| What | Where | Why |
| --- | --- | --- |
| The site | GitHub Pages | Free, and it only serves ~600 KB |
| The audio | Internet Archive | Free, permanent, and it serves HTTP 206 range requests so scrubbing works |
| Transcripts | In this repo | Small (about 100 KB gzipped per meeting) and worth version control |
| Raw Deepgram responses | Local only, gitignored | Large, regenerable, and already paid for |

## Adding a meeting

```bash
npm run prepare-meeting -- \
  --input "~/Downloads/Some Meeting.m4a" \
  --slug some-meeting \
  --title "Some Meeting" \
  --date 2026-08-14 \
  --body "Irvington Town Council"
```

That will:

1. Compress the audio to mono 64 kbps AAC with `ffmpeg`.
2. Transcribe it with Deepgram `nova-3`, using `content/<slug>/keyterms.txt`.
3. Cache the raw response so normalization never costs money again.
4. Normalize it to the schema in `scripts/lib/schema.ts`.
5. Apply `content/<slug>/corrections.json`, if present.
6. Scaffold `meta.json` and `speakers.json`.
7. Upload the audio to the Internet Archive and verify range requests work.

Then fill in the real speaker names in `content/<slug>/speakers.json`, check
`meta.json`, commit, and push. The deploy is automatic.

### Fixing a transcript

Editing `corrections.json` or `keyterms.txt` does **not** require paying for
transcription again:

```bash
npm run renormalize -- --slug some-meeting
```

That redoes steps 4–6 from the cached response in about a second. Only
`--force` on `prepare-meeting` re-transcribes, and only that costs money.

`corrections.json` looks like this:

```json
{
  "corrections": [
    { "find": "Irving ton", "replace": "Irvington" },
    { "find": "councilman smith", "replace": "Councilman Smith", "caseSensitive": false }
  ]
}
```

Corrections are applied to the word stream, not the finished text, so a fix
never desynchronises a word from its timing.

### Keyterms

`content/<slug>/keyterms.txt` is one term per line — place names,
councilmember surnames, project names, zoning jargon. It is the single
highest-leverage accuracy lever Deepgram offers. Adding names and re-running
with `--force` noticeably improves the result.

### Other transcript sources

The pipeline accepts SRT, VTT and Whisper JSON, so MacWhisper works as a
fallback without changing anything downstream:

```bash
npm run prepare-meeting -- --input audio.m4a --slug some-meeting \
  --transcript ~/Downloads/some-meeting.srt
```

SRT and VTT carry no word timings, so they are interpolated across each cue by
character length — close enough to highlight against.

## Credentials

Never committed, never passed as flags.

- `DEEPGRAM_API_KEY` — from the environment or `.env.local`.
- `ARCHIVE_ORG_S3_ACCESS_KEY` / `ARCHIVE_ORG_S3_SECRET_KEY` — from the
  environment, or `~/.archive-org-keys`. Generate at
  <https://archive.org/account/s3.php>.

Copy `.env.local.example` to `.env.local` to get started.

## Development

```bash
npm install
npm run dev
```

To play audio locally before it is uploaded, symlink it into `public/audio/`:

```bash
mkdir -p public/audio
ln -sf ../../content/<slug>/audio.m4a public/audio/<slug>.m4a
```

That directory is gitignored, and an Astro integration strips it out of
`dist/` so local audio can never be deployed by accident. CI fails the build
if any audio file reaches `dist/`.

## Notes for whoever works on this next

- **The npm script is `prepare-meeting`, not `prepare`.** npm treats a script
  literally named `prepare` as a lifecycle hook and runs it on every
  `npm install`.
- **`public/.nojekyll` is load-bearing.** GitHub Pages runs Jekyll, which
  silently strips directories beginning with an underscore — including
  Astro's `_astro/`. Without that file the site deploys and every stylesheet
  404s.
- **Per-word `<span>`s are built on demand.** Only the paragraph currently
  playing and paragraphs containing a search hit get them; everything else
  stays a single text node. A dense two-hour meeting would otherwise put
  20,000 spans in the DOM.
- **The transcript is rendered server-side.** That is what makes the page
  readable before the audio buffers and what makes it work with JavaScript
  off. `transcript.json` is fetched afterwards purely for word timings.
- **Deepgram's own paragraph grouping is not used.** It averaged 31 seconds
  per paragraph on the first meeting, with one running 156 seconds. We
  regroup from the word stream instead — see `scripts/lib/normalize.ts`.
- **Dimming non-selected speakers uses colour, not opacity.** Fading text far
  enough to read as "dimmed" drops it below WCAG AA contrast.
