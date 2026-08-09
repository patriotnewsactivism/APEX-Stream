/**
 * Feed fetching.
 *
 * No XML library: a dependency-light parser covering RSS 2.0 and Atom is
 * enough for feed ingestion and avoids pulling a parser with a history of
 * entity-expansion issues into a service that fetches attacker-influenced URLs.
 * Anything malformed is skipped rather than guessed at.
 */

export interface FeedItem {
  title: string | null;
  content: string;
  url: string | null;
  publishedAt: string | null;
}

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export async function fetchFeed(url: string, kind: string): Promise<FeedItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'APEX-Stream/1.0 (+monitoring; contact via platform operator)',
        accept: 'application/rss+xml, application/atom+xml, application/json;q=0.9, text/xml;q=0.8, */*;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new Error(`response too large: ${declared} bytes`);

    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('response exceeded size limit while reading');

    if (kind === 'http_api' || body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
      return parseJson(body);
    }
    return parseXmlFeed(body);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(body: string): FeedItem[] {
  const data: unknown = JSON.parse(body);
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown[] }).items)
      ? (data as { items: unknown[] }).items
      : Array.isArray((data as { results?: unknown[] }).results)
        ? (data as { results: unknown[] }).results
        : [data];

  return list.slice(0, 200).map((raw) => {
    const item = raw as Record<string, unknown>;
    const title = pickString(item, ['title', 'headline', 'name', 'subject']);
    const content = pickString(item, ['content', 'description', 'summary', 'body', 'text']) ?? JSON.stringify(item);
    return {
      title,
      content: content.slice(0, 200_000),
      url: pickString(item, ['url', 'link', 'permalink', 'href']),
      publishedAt: normaliseDate(pickString(item, ['publishedAt', 'published', 'date', 'pubDate', 'created_at', 'dateFiled'])),
    };
  });
}

function parseXmlFeed(body: string): FeedItem[] {
  const blocks = body.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.slice(0, 200).flatMap((block) => {
    const title = tag(block, 'title');
    const description = tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content');
    const link = tag(block, 'link') ?? attr(block, 'link', 'href');
    const published = tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated');
    const content = description ?? title;
    if (!content) return [];
    return [{
      title,
      content: content.slice(0, 200_000),
      url: link,
      publishedAt: normaliseDate(published),
    }];
  });
}

function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match?.[1]) return null;
  return decodeEntities(stripCdata(match[1])).trim() || null;
}

function attr(block: string, name: string, attribute: string): string | null {
  const match = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'i'));
  return match?.[1] ?? null;
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
