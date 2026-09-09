/**
 * Cross-meeting search on the index page (brief §7).
 *
 * The index JSON is fetched on the first keystroke and never again, so a
 * visitor who only wants to click a meeting never pays for it.
 */

type IndexedParagraph = [start: number, text: string, speaker: string];

interface IndexedMeeting {
  slug: string;
  title: string;
  body: string;
  date: string;
  p: IndexedParagraph[];
}

const MIN_QUERY = 2;
const MAX_PER_MEETING = 5;
const CONTEXT = 60;

const input = document.querySelector<HTMLInputElement>('[data-site-search]');
const results = document.querySelector<HTMLElement>('[data-results]');
const status = document.querySelector<HTMLElement>('[data-search-status]');
const listing = document.querySelector<HTMLElement>('[data-listing]');

let index: IndexedMeeting[] | null = null;
let loading: Promise<IndexedMeeting[]> | null = null;

function loadIndex(): Promise<IndexedMeeting[]> {
  loading ??= fetch('/search-index.json')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<IndexedMeeting[]>;
    })
    .then((data) => (index = data));
  return loading;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
}

/** A window of text around the match, with the match itself marked. */
function excerpt(text: string, at: number, length: number): string {
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(text.length, at + length + CONTEXT);

  return (
    (from > 0 ? '…' : '') +
    escapeHtml(text.slice(from, at)) +
    `<mark>${escapeHtml(text.slice(at, at + length))}</mark>` +
    escapeHtml(text.slice(at + length, to)) +
    (to < text.length ? '…' : '')
  );
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function render(query: string): void {
  if (!results || !status || !index) return;

  const needle = query.toLowerCase();
  let total = 0;
  const parts: string[] = [];

  // Grouped by meeting (§7), newest first — the index is already in that order.
  for (const meeting of index) {
    const hits: string[] = [];
    let found = 0;

    for (const [start, text, speaker] of meeting.p) {
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      found++;
      if (hits.length < MAX_PER_MEETING) {
        hits.push(
          `<li class="result">
             <a class="result__link" href="/${meeting.slug}#t=${start}">
               <span class="result__time">${formatTime(start)}</span>
               <span class="result__text">${excerpt(text, at, query.length)}</span>
             </a>
             <span class="result__speaker">${escapeHtml(speaker)}</span>
           </li>`,
        );
      }
    }

    if (found === 0) continue;
    total += found;

    parts.push(
      `<section class="result-group">
         <h3 class="result-group__title">
           <a href="/${meeting.slug}">${escapeHtml(meeting.title)}</a>
           <span class="result-group__count">${found} match${found === 1 ? '' : 'es'}</span>
         </h3>
         <ul class="result-group__list">${hits.join('')}</ul>
         ${found > MAX_PER_MEETING ? `<p class="result-group__more"><a href="/${meeting.slug}">See all ${found} in this meeting</a></p>` : ''}
       </section>`,
    );
  }

  results.innerHTML = parts.join('');
  results.hidden = parts.length === 0;
  status.textContent =
    total === 0
      ? `No matches for “${query}”.`
      : `${total} match${total === 1 ? '' : 'es'} across ${parts.length} meeting${parts.length === 1 ? '' : 's'}.`;

  // The full listing would only get in the way while results are showing.
  if (listing) listing.hidden = parts.length > 0;
}

function clear(): void {
  if (results) {
    results.innerHTML = '';
    results.hidden = true;
  }
  if (status) status.textContent = '';
  if (listing) listing.hidden = false;
}

if (input) {
  let timer = 0;

  input.addEventListener('input', () => {
    const query = input.value.trim();
    window.clearTimeout(timer);

    if (query.length < MIN_QUERY) {
      clear();
      return;
    }

    timer = window.setTimeout(async () => {
      if (!index) {
        if (status) status.textContent = 'Searching…';
        try {
          await loadIndex();
        } catch {
          if (status) status.textContent = 'Search is unavailable. Open a meeting and search inside it.';
          return;
        }
      }
      // The box may have moved on while the index was downloading.
      if (input.value.trim() === query) render(query);
    }, 180);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      clear();
    }
  });
}
