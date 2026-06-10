import type { ToolDefinition, ToolResult } from '../ToolRegistry';

export const GoogleSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for current information, news, documentation, error solutions, etc. ' +
    'Returns titles, short snippets, and URLs. ' +
    'To read the full content of a result page, follow up with fetch_url. ' +
    'Supports Japanese and English queries. ' +
    'TIPS: include place names and ABSOLUTE dates in the query (resolve "tomorrow" using the current date from context). ' +
    'For WEATHER, skip web_search — call fetch_url with "https://wttr.in/<city>?lang=ja" ' +
    '(plain-text forecast incl. tomorrow; append "&format=3" for a one-liner) — ' +
    'weather portal pages are JS-rendered and extract poorly.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string' },
      num_results: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
    },
    required: ['query'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args['query'] !== 'string' || !args['query']) {
      return { success: false, output: 'Missing required argument: query (string)' };
    }
    const query = args['query'];
    const limit = typeof args['num_results'] === 'number' ? Math.min(args['num_results'], 10) : 5;

    try {
      // 1) Try DuckDuckGo Instant Answer (good for definitions, calculations)
      const instant = await tryInstantAnswer(query);
      if (instant) return { success: true, output: instant };

      // 2) Fall back to DDG HTML search (returns actual web results)
      const html = await tryHtmlSearch(query, limit);
      return { success: true, output: html };
    } catch (err) {
      return { success: false, output: `Search failed: ${String(err)}` };
    }
  },
};

// ── DuckDuckGo Instant Answer API ─────────────────────────────────────────────

async function tryInstantAnswer(query: string): Promise<string | null> {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const data = await res.json() as {
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  // Only short-circuit when there is a REAL instant answer (AbstractText).
  // RelatedTopics alone is encyclopedic disambiguation noise — returning it
  // would suppress the actual web search results for the query.
  if (!data.AbstractText) return null;

  const lines: string[] = [`Summary: ${data.AbstractText}`];
  if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`);
  const related = (data.RelatedTopics ?? []).filter(t => t.Text).slice(0, 3);
  for (const t of related) {
    lines.push(`- ${t.Text}`);
    if (t.FirstURL) lines.push(`  ${t.FirstURL}`);
  }
  return lines.join('\n');
}

// ── DuckDuckGo HTML search (scraping) ────────────────────────────────────────

async function tryHtmlSearch(query: string, limit: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract result titles + URLs
  // DDG wraps hrefs as "//duckduckgo.com/l/?uddg=URL_ENCODED&..." — decode them.
  const links: Array<{ title: string; url: string }> = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = m[1];
    const actualUrl = extractActualUrl(rawUrl);
    if (!actualUrl) continue;
    const title = stripHtml(m[2]);
    if (title) links.push({ url: actualUrl, title });
  }

  // Extract snippets (same order as links)
  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/g;
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]));
  }

  const results: string[] = [];
  for (let i = 0; i < Math.min(links.length, limit); i++) {
    const { title, url } = links[i];
    const snippet = snippets[i] ?? '';
    results.push(snippet ? `${title}\n  ${snippet}\n  ${url}` : `${title}\n  ${url}`);
  }

  if (results.length === 0) {
    // Last resort: extract any plain https links from the page
    return extractFallbackLinks(html, limit);
  }
  return results.join('\n\n');
}

function extractActualUrl(href: string): string | null {
  // Direct non-DDG URL
  if (href.startsWith('http') && !href.includes('duckduckgo.com')) return href;
  // DDG redirect: //duckduckgo.com/l/?uddg=URL_ENCODED or /l/?uddg=URL_ENCODED
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }
  return null;
}

function extractFallbackLinks(html: string, limit: number): string {
  const seen = new Set<string>();
  const items: string[] = [];
  const re = /<a[^>]+href="(https?:\/\/(?!.*duckduckgo\.com)[^"]+)"[^>]*>([^<]{4,120})<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && items.length < limit) {
    const url = m[1];
    const title = m[2].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    items.push(`${title}\n  ${url}`);
  }
  return items.length > 0 ? items.join('\n\n') : '(no results found)';
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
