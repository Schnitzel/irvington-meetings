/**
 * The interactive player (brief §8). Vanilla TypeScript, no framework.
 *
 * Two ideas carry most of the design:
 *
 * 1. The transcript is already in the DOM as plain text. We only ever build
 *    per-word <span>s for the paragraph currently playing and for paragraphs
 *    holding a search hit, tearing them down again afterwards (§9). A
 *    two-hour meeting would otherwise put 20,000 spans on the page.
 *
 * 2. Everything the player needs about timing comes from transcript.json,
 *    fetched after first paint. Until it arrives the page is already readable.
 */

import type { Paragraph, Transcript } from '../../../scripts/lib/schema.ts';

const SKIP_SECONDS = 15;
/** How long manual scrolling suspends auto-scroll before it resumes (§8). */
const FOLLOW_RESUME_MS = 4000;
const POSITION_SAVE_MS = 5000;
/** Don't resume a saved position if the visitor had all but finished. */
const RESUME_MIN = 30;
const RESUME_TAIL = 20;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function speakTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m} minute${m === 1 ? '' : 's'} ${s} second${s === 1 ? '' : 's'}`;
}

/** Largest index whose value is <= target, or -1. Used for the playhead. */
function lastAtOrBefore(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

interface SearchMatch {
  paragraph: number;
  /** Index of the first and last word covered by the match. */
  fromWord: number;
  toWord: number;
  time: number;
}

class MeetingPlayer {
  private readonly root: HTMLElement;
  private readonly slug: string;
  private readonly audio: HTMLAudioElement;
  private readonly player: HTMLElement;
  private readonly fallback: HTMLElement | null;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;

  private transcript!: Transcript;
  private paragraphEls: HTMLElement[] = [];
  private paragraphStarts: number[] = [];
  /** Cumulative character offset of each word, per paragraph. Built lazily. */
  private wordOffsets = new Map<number, number[]>();

  private currentParagraph = -1;
  private currentWord = -1;
  private rendered = new Set<number>();

  private follow = true;
  private followSuspendedUntil = 0;
  private programmaticScroll = false;

  private matches: SearchMatch[] = [];
  private matchIndex = -1;
  private query = '';
  /** Set once the search UI is bound; redraws the "3/21" counter. */
  private paintCount: () => void = () => {};

  private soloSpeaker: string | null = null;
  private scrubbing = false;
  private frame = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.slug = root.dataset.slug!;
    this.player = root.querySelector<HTMLElement>('[data-player]')!;
    this.audio = root.querySelector<HTMLAudioElement>('[data-audio]')!;
    this.fallback = root.querySelector<HTMLElement>('[data-fallback]');
    this.body = root.querySelector<HTMLElement>('[data-transcript-body]')!;
    this.status = root.querySelector<HTMLElement>('[data-status]')!;
  }

  async start(): Promise<void> {
    // Reveal the real player and retire the no-JS audio element (§9).
    this.player.hidden = false;
    if (this.fallback) this.fallback.hidden = true;
    // The static speaker list is the scripting-off equivalent of the player's
    // legend; showing both just says the same thing twice.
    const staticSpeakers = this.root.querySelector<HTMLElement>('.speakers');
    if (staticSpeakers && this.player.querySelector('[data-speaker-toggle]')) {
      staticSpeakers.hidden = true;
    }

    this.paragraphEls = [...this.body.querySelectorAll<HTMLElement>('.para')];

    try {
      const response = await fetch(this.root.dataset.transcript!);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.transcript = await response.json();
    } catch (error) {
      // The transcript text is already on the page, so this degrades to a
      // plain audio player rather than a broken one.
      this.say('Could not load the synchronised transcript. The recording and the text below still work.');
      if (this.fallback) this.fallback.hidden = false;
      this.player.hidden = true;
      console.error('[player] transcript failed to load', error);
      return;
    }

    this.paragraphStarts = this.transcript.paragraphs.map((p) => p.start);

    this.enhanceParagraphs();
    this.bindTransport();
    this.bindTimeline();
    this.bindSearch();
    this.bindLegend();
    this.bindFollow();
    this.bindKeyboard();
    this.bindPositionMemory();

    for (const button of this.player.querySelectorAll<HTMLButtonElement>('button[disabled]')) {
      button.disabled = false;
    }
    this.root.querySelector<HTMLElement>('[data-total]')!.textContent = formatTime(
      this.transcript.duration,
    );

    this.applyStartPosition();
    this.tick();
  }

  private say(message: string): void {
    this.status.textContent = message;
  }

  // --- Transcript DOM ----------------------------------------------------

  /** Adds a copy-link control to every paragraph (§8). */
  private enhanceParagraphs(): void {
    for (const [i, el] of this.paragraphEls.entries()) {
      const paragraph = this.transcript.paragraphs[i];
      if (!paragraph) continue;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'para__copy';
      button.title = 'Copy a link to this moment';
      button.setAttribute('aria-label', `Copy a link to ${formatTime(paragraph.start)}`);
      button.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm5-6v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10h-4z" fill="currentColor"/>' +
        '</svg>';
      button.addEventListener('click', () => this.copyLink(paragraph, button));
      el.querySelector('.para__body')!.appendChild(button);

      // Clicking the timestamp seeks rather than only changing the hash.
      el.querySelector<HTMLAnchorElement>('.para__time')?.addEventListener('click', (event) => {
        event.preventDefault();
        this.seek(paragraph.start, true);
      });

      // One listener per paragraph rather than per word: the word is resolved
      // from the click target at the moment it happens (§8, §10.4).
      el.addEventListener('click', (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('.word');
        if (!target) return;
        this.seek(Number(target.dataset.s), true);
      });
    }
  }

  private async copyLink(paragraph: Paragraph, button: HTMLElement): Promise<void> {
    const url = new URL(window.location.href);
    url.hash = `t=${paragraph.start.toFixed(2)}`;
    const link = url.toString();

    try {
      await navigator.clipboard.writeText(link);
      button.classList.add('is-copied');
      this.say(`Copied a link to ${formatTime(paragraph.start)}`);
      setTimeout(() => button.classList.remove('is-copied'), 1600);
    } catch {
      // Clipboard access can be refused; putting the link in the address bar
      // still lets the visitor copy it themselves.
      window.location.hash = `t=${paragraph.start.toFixed(2)}`;
      this.say('Copy the address bar to share this moment.');
    }
  }

  /**
   * Replaces a paragraph's plain text with per-word spans. Only ever called
   * for the playing paragraph and for paragraphs holding a search hit.
   */
  private renderWords(index: number): void {
    if (this.rendered.has(index)) return;
    const paragraph = this.transcript.paragraphs[index];
    const el = this.paragraphEls[index];
    if (!paragraph || !el) return;

    const host = el.querySelector<HTMLElement>('[data-text]')!;
    const hits = this.matchesIn(index);
    const fragment = document.createDocumentFragment();

    for (const [i, word] of paragraph.words.entries()) {
      const span = document.createElement('span');
      span.className = 'word';
      span.dataset.s = String(word.s);
      span.dataset.i = String(i);
      span.textContent = word.t;

      if (hits.some((m) => i >= m.fromWord && i <= m.toWord)) {
        span.classList.add('word--hit');
      }
      fragment.appendChild(span);
      if (i < paragraph.words.length - 1) fragment.appendChild(document.createTextNode(' '));
    }

    host.replaceChildren(fragment);
    this.rendered.add(index);
  }

  /** Collapses a paragraph back to a single text node. */
  private unrenderWords(index: number): void {
    if (!this.rendered.has(index)) return;
    // A paragraph holding search hits keeps its spans, or the highlights vanish.
    if (this.matchesIn(index).length > 0) return;

    const paragraph = this.transcript.paragraphs[index];
    const host = this.paragraphEls[index]?.querySelector<HTMLElement>('[data-text]');
    if (!paragraph || !host) return;

    host.textContent = paragraph.text;
    this.rendered.delete(index);
  }

  private matchesIn(index: number): SearchMatch[] {
    return this.matches.filter((m) => m.paragraph === index);
  }

  // --- Playback ----------------------------------------------------------

  private bindTransport(): void {
    const playButton = this.root.querySelector<HTMLButtonElement>('[data-play]')!;

    playButton.addEventListener('click', () => this.toggle());

    // Which glyph shows is decided in CSS from .is-playing; toggling `hidden`
    // on an <svg> is not reliable.
    const reflect = () => {
      const playing = !this.audio.paused;
      playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this.player.classList.toggle('is-playing', playing);
      if (playing) this.tick();
    };
    this.audio.addEventListener('play', reflect);
    this.audio.addEventListener('pause', reflect);

    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-skip]')) {
      button.addEventListener('click', () => {
        this.seek(this.audio.currentTime + Number(button.dataset.skip), false);
      });
    }

    const speed = this.root.querySelector<HTMLSelectElement>('[data-speed]')!;
    speed.addEventListener('change', () => {
      this.audio.playbackRate = Number(speed.value);
    });

    this.audio.addEventListener('error', () => {
      this.say('The audio could not be loaded. Try the download link above.');
    });
  }

  private toggle(): void {
    if (this.audio.paused) void this.audio.play().catch(() => this.say('Playback was blocked.'));
    else this.audio.pause();
  }

  private seek(time: number, andPlay: boolean): void {
    const clamped = Math.max(0, Math.min(time, this.transcript.duration));
    this.audio.currentTime = clamped;
    // A deliberate jump always re-engages following, otherwise the transcript
    // stays where the visitor last scrolled and the seek looks broken.
    this.followSuspendedUntil = 0;
    if (andPlay && this.audio.paused) void this.audio.play().catch(() => {});
    this.update(true);
  }

  // --- Timeline ----------------------------------------------------------

  private bindTimeline(): void {
    const timeline = this.root.querySelector<HTMLElement>('[data-timeline]')!;
    const hover = this.root.querySelector<HTMLElement>('[data-hover]')!;

    const timeAt = (clientX: number): number => {
      const box = timeline.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      return ratio * this.transcript.duration;
    };

    timeline.addEventListener('pointerdown', (event) => {
      this.scrubbing = true;
      timeline.setPointerCapture(event.pointerId);
      this.seek(timeAt(event.clientX), false);
    });
    timeline.addEventListener('pointermove', (event) => {
      if (this.scrubbing) {
        this.seek(timeAt(event.clientX), false);
        return;
      }
      // Hover preview of the timestamp under the cursor (§8).
      const box = timeline.getBoundingClientRect();
      const time = timeAt(event.clientX);
      hover.hidden = false;
      hover.textContent = formatTime(time);
      hover.style.left = `${Math.max(0, Math.min(box.width, event.clientX - box.left))}px`;
    });
    timeline.addEventListener('pointerleave', () => {
      hover.hidden = true;
    });
    const stop = (event: PointerEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      timeline.releasePointerCapture?.(event.pointerId);
    };
    timeline.addEventListener('pointerup', stop);
    timeline.addEventListener('pointercancel', stop);

    // The timeline is a slider, so it answers to arrow keys when focused.
    timeline.addEventListener('keydown', (event) => {
      const step =
        event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -SKIP_SECONDS
          : event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? SKIP_SECONDS
            : event.key === 'Home'
              ? -Infinity
              : event.key === 'End'
                ? Infinity
                : null;
      if (step === null) return;
      event.preventDefault();
      this.seek(
        step === -Infinity ? 0 : step === Infinity ? this.transcript.duration : this.audio.currentTime + step,
        false,
      );
    });

    this.audio.addEventListener('progress', () => this.paintBuffered());
  }

  private paintBuffered(): void {
    const buffered = this.root.querySelector<HTMLElement>('[data-buffered]')!;
    const ranges = this.audio.buffered;
    if (ranges.length === 0) return;
    const end = ranges.end(ranges.length - 1);
    buffered.style.width = `${(end / this.transcript.duration) * 100}%`;
  }

  private paintMarks(): void {
    const marks = this.root.querySelector<HTMLElement>('[data-marks]')!;
    marks.replaceChildren();
    if (this.matches.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const [i, match] of this.matches.entries()) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'timeline__mark';
      // Inside an aria-hidden container, and reachable via next/previous.
      mark.tabIndex = -1;
      mark.style.left = `${(match.time / this.transcript.duration) * 100}%`;
      mark.title = `Match at ${formatTime(match.time)}`;
      mark.setAttribute('aria-label', `Match ${i + 1} at ${formatTime(match.time)}`);
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        this.goToMatch(i, true);
      });
      mark.addEventListener('pointerdown', (event) => event.stopPropagation());
      fragment.appendChild(mark);
    }
    marks.appendChild(fragment);
  }

  // --- The per-frame update ---------------------------------------------

  private tick = (): void => {
    this.update(false);
    cancelAnimationFrame(this.frame);
    if (!this.audio.paused) this.frame = requestAnimationFrame(this.tick);
  };

  private update(force: boolean): void {
    const time = this.audio.currentTime;
    const duration = this.transcript.duration;

    this.root.querySelector<HTMLElement>('[data-current]')!.textContent = formatTime(time);
    const ratio = duration > 0 ? Math.min(1, time / duration) : 0;
    this.root.querySelector<HTMLElement>('[data-fill]')!.style.width = `${ratio * 100}%`;
    this.root.querySelector<HTMLElement>('[data-handle]')!.style.left = `${ratio * 100}%`;

    const timeline = this.root.querySelector<HTMLElement>('[data-timeline]')!;
    timeline.setAttribute('aria-valuenow', String(Math.round(time)));
    timeline.setAttribute('aria-valuetext', speakTime(time));

    const index = lastAtOrBefore(this.paragraphStarts, time);
    if (index !== this.currentParagraph || force) {
      if (this.currentParagraph >= 0) {
        this.paragraphEls[this.currentParagraph]?.classList.remove('is-current');
        this.unrenderWords(this.currentParagraph);
      }
      this.currentParagraph = index;
      this.currentWord = -1;

      if (index >= 0) {
        this.renderWords(index);
        this.paragraphEls[index]?.classList.add('is-current');
        this.autoScroll(this.paragraphEls[index]);
      }
    }

    if (this.currentParagraph >= 0) this.highlightWord(time);
  }

  private highlightWord(time: number): void {
    const paragraph = this.transcript.paragraphs[this.currentParagraph];
    const el = this.paragraphEls[this.currentParagraph];
    if (!paragraph || !el) return;

    let index = -1;
    for (let i = paragraph.words.length - 1; i >= 0; i--) {
      if (paragraph.words[i].s <= time) {
        index = i;
        break;
      }
    }
    if (index === this.currentWord) return;

    el.querySelector('.word--now')?.classList.remove('word--now');
    this.currentWord = index;
    if (index < 0) return;
    el.querySelector<HTMLElement>(`.word[data-i="${index}"]`)?.classList.add('word--now');
  }

  // --- Auto-scroll -------------------------------------------------------

  private bindFollow(): void {
    const toggle = this.root.querySelector<HTMLInputElement>('[data-follow]')!;
    toggle.addEventListener('change', () => {
      this.follow = toggle.checked;
      this.followSuspendedUntil = 0;
      if (this.follow && this.currentParagraph >= 0) {
        this.autoScroll(this.paragraphEls[this.currentParagraph]);
      }
    });

    // Manual scrolling suspends following, which then resumes on its own
    // after a few quiet seconds (§8).
    window.addEventListener(
      'scroll',
      () => {
        if (this.programmaticScroll || !this.follow) return;
        this.followSuspendedUntil = Date.now() + FOLLOW_RESUME_MS;
        this.player.classList.add('is-detached');
        window.setTimeout(() => {
          if (Date.now() >= this.followSuspendedUntil) {
            this.player.classList.remove('is-detached');
          }
        }, FOLLOW_RESUME_MS + 50);
      },
      { passive: true },
    );
  }

  private autoScroll(el: HTMLElement | undefined): void {
    if (!el || !this.follow || Date.now() < this.followSuspendedUntil) return;

    const box = el.getBoundingClientRect();
    const comfortable = box.top > window.innerHeight * 0.28 && box.bottom < window.innerHeight * 0.85;
    if (comfortable) return;

    this.programmaticScroll = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    // scroll events keep firing after scrollIntoView resolves; this window is
    // long enough to cover a smooth scroll without swallowing a real one.
    window.setTimeout(() => {
      this.programmaticScroll = false;
    }, reduced ? 60 : 700);
  }

  // --- Search ------------------------------------------------------------

  private bindSearch(): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-search]')!;
    const nav = this.root.querySelector<HTMLElement>('[data-search-nav]')!;
    const count = this.root.querySelector<HTMLElement>('[data-search-count]')!;

    // Redrawing the counter is deliberately separate from re-running the
    // search: stepping between matches must not reset which match is current.
    const paint = () => {
      nav.hidden = this.query.length === 0;
      count.textContent =
        this.query.length === 0
          ? ''
          : this.matches.length === 0
            ? 'No matches'
            : `${this.matchIndex + 1}/${this.matches.length}`;
    };
    this.paintCount = paint;

    let timer = 0;
    const run = () => {
      this.search(input.value);
      paint();
    };

    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 140);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        window.clearTimeout(timer);
        // Enter on an unchanged query steps; on a new one it searches first.
        if (input.value.trim() !== this.query) run();
        else this.step(event.shiftKey ? -1 : 1);
        paint();
      } else if (event.key === 'Escape') {
        input.value = '';
        run();
        input.blur();
      }
    });

    this.root.querySelector('[data-search-next]')!.addEventListener('click', () => {
      this.step(1);
      paint();
    });
    this.root.querySelector('[data-search-prev]')!.addEventListener('click', () => {
      this.step(-1);
      paint();
    });
    this.root.querySelector('[data-search-clear]')!.addEventListener('click', () => {
      input.value = '';
      run();
      input.focus();
    });
  }

  /** Character offsets of each word within a paragraph's joined text. */
  private offsetsFor(index: number): number[] {
    let offsets = this.wordOffsets.get(index);
    if (offsets) return offsets;

    offsets = [];
    let cursor = 0;
    for (const word of this.transcript.paragraphs[index].words) {
      offsets.push(cursor);
      cursor += word.t.length + 1;
    }
    this.wordOffsets.set(index, offsets);
    return offsets;
  }

  private search(raw: string): void {
    const query = raw.trim();
    const previous = new Set(this.matches.map((m) => m.paragraph));

    this.query = query;
    this.matches = [];
    this.matchIndex = -1;

    if (query.length >= 2) {
      const needle = query.toLowerCase();
      for (const [index, paragraph] of this.transcript.paragraphs.entries()) {
        const haystack = paragraph.text.toLowerCase();
        let from = haystack.indexOf(needle);
        if (from === -1) continue;

        const offsets = this.offsetsFor(index);
        while (from !== -1) {
          const to = from + needle.length;
          const fromWord = Math.max(0, lastAtOrBefore(offsets, from));
          let toWord = fromWord;
          while (toWord + 1 < offsets.length && offsets[toWord + 1] < to) toWord++;

          this.matches.push({
            paragraph: index,
            fromWord,
            toWord,
            time: paragraph.words[fromWord].s,
          });
          from = haystack.indexOf(needle, from + needle.length);
        }
      }
    }

    // Rebuild spans for every paragraph whose highlighting changed, and drop
    // the ones that no longer need them.
    const affected = new Set([...previous, ...this.matches.map((m) => m.paragraph)]);
    for (const index of affected) {
      if (index === this.currentParagraph) {
        this.rendered.delete(index);
        this.renderWords(index);
        this.currentWord = -1;
        this.highlightWord(this.audio.currentTime);
      } else if (this.matchesIn(index).length > 0) {
        this.rendered.delete(index);
        this.renderWords(index);
      } else {
        this.rendered.add(index);
        this.unrenderWords(index);
      }
    }

    this.paintMarks();

    if (this.matches.length > 0) {
      // Start from the match nearest the playhead, not always the first one.
      const near = this.matches.findIndex((m) => m.time >= this.audio.currentTime);
      this.goToMatch(near === -1 ? 0 : near, false);
    }
  }

  private step(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    const next = (this.matchIndex + direction + this.matches.length) % this.matches.length;
    this.goToMatch(next, false);
  }

  private goToMatch(index: number, andSeek: boolean): void {
    if (index < 0 || index >= this.matches.length) return;
    this.matchIndex = index;
    this.paintCount();
    const match = this.matches[index];

    for (const el of this.root.querySelectorAll('.word--hit-current')) {
      el.classList.remove('word--hit-current');
    }
    for (const el of this.root.querySelectorAll('.timeline__mark.is-current')) {
      el.classList.remove('is-current');
    }
    this.root
      .querySelectorAll<HTMLElement>('.timeline__mark')
      [index]?.classList.add('is-current');

    if (andSeek) {
      this.seek(match.time, false);
      return;
    }

    this.renderWords(match.paragraph);
    const el = this.paragraphEls[match.paragraph];
    const word = el?.querySelector<HTMLElement>(`.word[data-i="${match.fromWord}"]`);
    word?.classList.add('word--hit-current');

    // Jumping between matches is a deliberate move away from the playhead, so
    // it takes precedence over following.
    this.followSuspendedUntil = Date.now() + FOLLOW_RESUME_MS;
    this.programmaticScroll = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    (word ?? el)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    window.setTimeout(() => {
      this.programmaticScroll = false;
    }, reduced ? 60 : 700);
  }

  // --- Speaker legend ----------------------------------------------------

  private bindLegend(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-speaker-toggle]')) {
      button.addEventListener('click', () => {
        const id = button.dataset.speakerToggle!;
        this.soloSpeaker = this.soloSpeaker === id ? null : id;

        for (const other of this.root.querySelectorAll<HTMLButtonElement>('[data-speaker-toggle]')) {
          const on = other.dataset.speakerToggle === this.soloSpeaker;
          other.setAttribute('aria-pressed', String(on));
          other.classList.toggle('is-solo', on);
        }
        this.body.classList.toggle('is-dimmed', this.soloSpeaker !== null);
        this.body.dataset.solo = this.soloSpeaker ?? '';
        this.say(
          this.soloSpeaker
            ? `Showing ${button.textContent?.trim()}. Everyone else is dimmed.`
            : 'Showing every speaker.',
        );
      });
    }
  }

  // --- Keyboard ----------------------------------------------------------

  private bindKeyboard(): void {
    document.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      const typing =
        target.matches('input, textarea, select') || target.isContentEditable;

      if (event.key === '/' && !typing) {
        event.preventDefault();
        this.root.querySelector<HTMLInputElement>('[data-search]')!.focus();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      // The timeline handles its own arrow keys when focused.
      if (target.matches('[data-timeline]')) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          this.toggle();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.seek(this.audio.currentTime - SKIP_SECONDS, false);
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.seek(this.audio.currentTime + SKIP_SECONDS, false);
          break;
      }
    });
  }

  // --- Position: deep links and resume -----------------------------------

  private hashTime(): number | null {
    const match = window.location.hash.match(/^#t=(\d+(?:\.\d+)?)$/);
    return match ? Number(match[1]) : null;
  }

  private applyStartPosition(): void {
    const apply = () => {
      const target = this.hashTime();
      if (target !== null) {
        this.seek(target, false);
        this.say(`Starting at ${formatTime(target)}`);
        return true;
      }
      return false;
    };

    // currentTime only sticks once the audio element knows its duration.
    if (this.audio.readyState >= 1) {
      if (!apply()) this.restorePosition();
    } else {
      this.audio.addEventListener(
        'loadedmetadata',
        () => {
          if (!apply()) this.restorePosition();
          this.update(true);
        },
        { once: true },
      );
      // Show the right paragraph immediately even before metadata arrives.
      const target = this.hashTime();
      if (target !== null) this.previewAt(target);
    }

    window.addEventListener('hashchange', () => {
      const target = this.hashTime();
      if (target !== null) this.seek(target, false);
    });
  }

  /** Scrolls to a moment without touching the audio element. */
  private previewAt(time: number): void {
    const index = lastAtOrBefore(this.paragraphStarts, time);
    if (index < 0) return;
    this.renderWords(index);
    this.paragraphEls[index]?.classList.add('is-current');
    this.currentParagraph = index;
    this.paragraphEls[index]?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  private storageKey(): string {
    return `irvington-meetings:position:${this.slug}`;
  }

  private restorePosition(): void {
    let saved: number;
    try {
      saved = Number(window.localStorage.getItem(this.storageKey()));
    } catch {
      return; // Storage can be blocked outright; it is only a convenience.
    }
    if (!Number.isFinite(saved) || saved < RESUME_MIN) return;
    if (saved > this.transcript.duration - RESUME_TAIL) return;

    this.seek(saved, false);
    this.say(`Resumed where you left off, at ${formatTime(saved)}.`);
  }

  private bindPositionMemory(): void {
    let last = 0;
    const save = () => {
      const now = Date.now();
      if (now - last < POSITION_SAVE_MS) return;
      last = now;
      try {
        window.localStorage.setItem(this.storageKey(), String(this.audio.currentTime));
      } catch {
        /* storage unavailable — nothing to do */
      }
    };
    this.audio.addEventListener('timeupdate', save);
    window.addEventListener('pagehide', () => {
      try {
        window.localStorage.setItem(this.storageKey(), String(this.audio.currentTime));
      } catch {
        /* ignored */
      }
    });
  }
}

const root = document.querySelector<HTMLElement>('.recording');
if (root) void new MeetingPlayer(root).start();
