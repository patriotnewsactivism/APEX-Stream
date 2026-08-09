/**
 * Page fetching and readable-text extraction.
 *
 * Extraction strips scripts, styles, navigation and boilerplate before
 * fingerprinting. Without this, a rotating ad slot or a "3 minutes ago"
 * timestamp registers as a content change on every poll and buries the real
 * edits under false positives.
 */

export interface FetchedPage {
  html: string;
  title: string | null;
  status: number;
  etag: string | null;
  lastModified: string | null;
}

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

export async function fetchPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'APEX-Stream/1.0 (+monitoring; contact via platform operator)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    if (html.length > MAX_BYTES) throw new Error('page exceeded size limit');

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return {
      html,
      title: titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? null,
      status: res.status,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  } finally {
    clearTimeout(timer);
  }
}

const STRIP_BLOCKS = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi;

export function extractReadableText(html: string): string {
  const withoutChrome = html
    .replace(STRIP_BLOCKS, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Prefer semantic containers when present — they exclude most boilerplate.
  const article =
    withoutChrome.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    withoutChrome.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    withoutChrome;

  return article
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    // Volatile fragments that change on every fetch without the page changing.
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/gi, ' ')
    .replace(/\b\d+\s+(seconds?|minutes?|hours?|days?)\s+ago\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200_000);
}

const CORRECTION_PATTERNS = [
  /\bcorrection\b/i,
  /\bcorrected\b/i,
  /\bupdate[d]?\s*:/i,
  /\beditor'?s note\b/i,
  /\bthis (article|story|post) (was|has been) updated\b/i,
  /\ban earlier version\b/i,
  /\bclarification\b/i,
  /\bretract(ed|ion)\b/i,
];

/** True when the page openly says it changed. */
export function hasCorrectionNotice(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}
