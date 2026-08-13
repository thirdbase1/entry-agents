---
name: web-search
description: Searches the public web for a query and returns titles, links, and snippets. Use when the user asks to search for, look up, or find current information online, find a documentation page, or research a topic outside your training data — anything that needs a search rather than a specific known URL.
---

# Web Search (no API key required)

This skill searches the web via DuckDuckGo's lightweight HTML endpoint using `curl` — no API key or
browser needed. Use the `web_fetch` tool directly (not `agent-browser`) since this is a plain HTTP GET.

## Usage

Fetch results for a query:

```
GET https://html.duckduckgo.com/html/?q=<url-encoded query>
```

with header `User-Agent: Mozilla/5.0 (compatible; entry-agent/1.0)` (DuckDuckGo's lite HTML endpoint
sometimes blocks requests with no user agent).

Call the `web_fetch` tool with that URL and header. The response body is raw HTML. Result entries look like:

```html
<a class="result__a" href="https://example.com/page">Example Page Title</a>
...
<a class="result__snippet">A short snippet describing the page...</a>
```

Read through the returned HTML yourself and extract, for each result: the title (text inside
`result__a` links), the URL (the `href` — note DuckDuckGo wraps some URLs in a redirect like
`//duckduckgo.com/l/?uddg=<encoded-real-url>`; decode/extract the real URL from `uddg=`), and the
snippet (text inside `result__snippet` elements). Present the top 5-8 results to the user with title,
url, and a one-line snippet each — don't dump raw HTML into your reply.

## Follow-up: reading a result page

Once you have a URL worth reading in full, don't try to parse search-result HTML further — fetch the
actual page:

- Prefer `agent-browser read <url>` if the `agent-browser` skill is available and already installed in
  this session (it returns clean agent-readable text/markdown, handles JS-rendered pages, and follows
  `llms.txt` for docs sites).
- Otherwise fall back to the `web_fetch` tool directly on the URL and read the raw HTML/text yourself.

## When search results aren't enough

If DuckDuckGo's HTML results seem sparse or stale for a query (common for very recent news or niche
technical terms), try rephrasing the query, or fetch a likely canonical source directly (e.g. a known
docs domain, GitHub repo, or official site) instead of retrying the same search repeatedly.

## Example

User asks: "what's the latest version of Next.js"

1. `web_fetch` → `https://html.duckduckgo.com/html/?q=latest+Next.js+version` with the User-Agent header above
2. Extract top results, note any that look authoritative (nextjs.org, github.com/vercel/next.js)
3. If needed, `web_fetch` (or `agent-browser read`) the authoritative URL directly for the precise answer
4. Answer the user directly with the version and cite the source URL
