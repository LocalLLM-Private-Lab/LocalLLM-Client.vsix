import type { ToolDefinition, ToolResult } from '../ToolRegistry';

/** Same-URL re-fetches are common when the model cross-checks an API doc it
 *  read earlier in the session. Serve those from a TTL cache: faster, no
 *  network flakiness mid-run, and the content stays consistent between the
 *  two reads. JSON responses are NOT cached (weather/API data is dynamic). */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const pageCache = new Map<string, { at: number; text: string }>();

function cacheGet(url: string): { text: string; ageMin: number } | null {
  const hit = pageCache.get(url);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age > CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  return { text: hit.text, ageMin: Math.round(age / 60000) };
}

function cachePut(url: string, text: string): void {
  if (pageCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(url, { at: Date.now(), text });
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text || '(empty page)';
  return (
    text.slice(0, maxChars) +
    `\n\n[truncated — ${text.length} total chars; increase max_chars to read more]`
  );
}

export const FetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description:
    'Fetch the full text content of a web page from its URL. ' +
    'Use this after web_search to read the complete content of a result page. ' +
    'Returns extracted text with HTML, scripts, and navigation stripped out.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters to return (default 6000, max 12000)',
      },
    },
    required: ['url'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args['url'] !== 'string' || !args['url']) {
      return { success: false, output: 'Missing required argument: url' };
    }
    const url = args['url'];
    const maxChars =
      typeof args['max_chars'] === 'number' ? Math.min(args['max_chars'], 12000) : 6000;

    const cached = cacheGet(url);
    if (cached) {
      return {
        success: true,
        output:
          `[cached copy fetched ${cached.ageMin} min ago — identical to the earlier fetch]\n` +
          clip(cached.text, maxChars),
      };
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });

      if (!res.ok) {
        return { success: false, output: `HTTP ${res.status}: ${res.statusText}` };
      }

      const contentType = res.headers.get('content-type') ?? '';
      const isJson = contentType.includes('json');
      if (
        !contentType.includes('text/') &&
        !contentType.includes('application/xhtml') &&
        !contentType.includes('application/xml') &&
        !isJson
      ) {
        return { success: false, output: `Cannot read content-type: ${contentType}` };
      }

      const body = await res.text();
      // JSON APIs (weather, package registries, …) are returned verbatim —
      // HTML tag stripping would only mangle them.
      const text = isJson ? body : extractText(body);

      if (!isJson && text) cachePut(url, text);
      return { success: true, output: clip(text, maxChars) };
    } catch (err) {
      return { success: false, output: `Fetch failed: ${String(err)}` };
    }
  },
};

function extractText(html: string): string {
  return html
    // Remove noise blocks entirely before stripping tags
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Block-level elements → newline so text doesn't run together
    .replace(/<\/?(p|div|h[1-6]|li|tr|td|th|blockquote|section|article|br|hr)[^>]*>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]{2,8};/g, ' ')
    // Normalise whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
