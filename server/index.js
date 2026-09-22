import "dotenv/config";
import express from "express";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 8787;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // e.g. https://carvv.app (empty = same-origin / dev proxy)

app.set("trust proxy", 1); // one reverse proxy hop (Railway/Render/Fly) — needed for correct per-IP rate limits
app.use(express.json({ limit: "1mb" }));

// Security headers on every response
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("X-Frame-Options", "DENY");
  next();
});

// Tight CORS: no origin allowlist configured -> same-origin/dev only; configured -> that origin only
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- tiny in-memory rate limiter (per IP, fixed window) ----
const buckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > limit) return res.status(429).json({ error: "Too many requests. Slow down and try again in a moment." });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

// ---- shared outbound fetch with timeout + one retry on 429/5xx ----
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function fetchText(url, { timeoutMs = 12000, retry = true } = {}) {
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: ac.signal, redirect: "follow" });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) { clearTimeout(to); await new Promise(r => setTimeout(r, 1200)); continue; }
      if (!res.ok) { const e = new Error(`Fetch failed (${res.status})`); e.status = res.status; throw e; }
      return await res.text();
    } finally { clearTimeout(to); }
  }
  const e = new Error("Fetch failed (retries exhausted)"); e.status = 502; throw e;
}

const normSpace = (s) => String(s || "").replace(/\s+/g, " ").trim();

app.get("/api/health", (_req, res) => res.json({ ok: true, ai: Boolean(OPENROUTER_KEY), search: true }));

/* -------- real web search (no API key): DuckDuckGo's public HTML endpoint -------- */
app.get("/api/search", rateLimit("search", 60, 60_000), async (req, res) => {
  const q = normSpace(req.query.q).slice(0, 200);
  if (!q) return res.status(400).json({ error: "Missing q" });
  try {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    const $ = cheerio.load(html);
    const out = [];
    const seen = new Set();
    $(".result, .web-result, .results_links").each((_, el) => {
      if (out.length >= 8) return false;
      const $el = $(el);
      const a = $el.find(".result__a, .result-link").first();
      let href = a.attr("href") || "";
      // DDG wraps target urls in a redirect param — unwrap to the real destination
      const m = href.match(/uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
      let host = "";
      try { host = new URL(href).hostname.replace(/^www\./, ""); } catch { return; }
      if (!host || seen.has(host)) return;
      if (/duckduckgo|microsoft\.com\/en-us\/bing|yandex|baidu/.test(host)) return; // ads/self links
      seen.add(host);
      out.push({
        title: normSpace(a.text()),
        url: href,
        snippet: normSpace($el.find(".result__snippet, .result-snippet").first().text()),
        publisher: host,
      });
    });
    res.json({ results: out });
  } catch (e) {
    res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? "Search is rate limited right now." : "Search failed. Try again." });
  }
});

/* -------- scrape: fetch a URL and extract clean readable text -------- */
app.get("/api/scrape", rateLimit("scrape", 120, 60_000), async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });

  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  // Block obvious internal/loopback targets (SSRF hygiene)
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host === "[::1]") {
    return res.status(400).json({ error: "That address is not allowed" });
  }

  try {
    const html = await fetchText(parsed.toString());
    const $ = cheerio.load(html);

    $("script, style, noscript, svg, canvas, iframe, nav, footer, header, form, aside").remove();
    $("[class*='cookie'], [id*='cookie'], [class*='newsletter'], [class*='subscribe'], [class*='popup'], [class*='modal'], [class*='advert'], [id*='advert']").remove();

    const title = normSpace($("meta[property='og:title']").attr("content")) || normSpace($("title").first().text()) || parsed.hostname;
    const byline = normSpace($("meta[name='author']").attr("content")) ||
      normSpace($("meta[property='article:author']").attr("content")) || "";

    const candidates = ["article", "main", "[role='main']", ".post-content", ".article-body", ".entry-content", ".story-body", "body"];
    let text = "";
    for (const sel of candidates) {
      const t = normSpace($(sel).first().text());
      if (t.length > text.length) text = t;
      if (text.length > 600) break;
    }

    text = text.slice(0, 6000);
    if (text.length < 120) return res.status(422).json({ error: "Could not extract readable content from that page" });

    const pub = parsed.hostname.replace(/^www\./, "");
    res.json({ url: parsed.toString(), title, byline, publisher: pub, site: pub, text });
  } catch (e) {
    const status = e.name === "AbortError" ? 504 : (e.status === 429 ? 429 : 502);
    res.status(status).json({ error: status === 504 ? "That page took too long to respond" : status === 429 ? "That site is rate limiting requests." : "Could not fetch that page" });
  }
});

/* -------- AI: OpenRouter proxy (key stays server-side) --------
   Contract with src/services/ai.js:
     in:  { inputType, value, options:{slides,auto,platform,style,template},
            source, sources, sourceDocs }
     out: { title, score, sources:[{publisher,title,url,confidence}],
            slides:[SlideSpec] }  — the exact shape normalizeStory() validates. */
app.post("/api/ai/story", rateLimit("ai", 20, 60_000), async (req, res) => {
  if (!OPENROUTER_KEY) return res.status(503).json({ error: "OPENROUTER_API_KEY is not configured on the server" });

  const { inputType, value, options = {}, source, sources, sourceDocs } = req.body || {};
  const topic = normSpace(value).slice(0, 600);

  // Fetched material the model may cite: the primary page plus extra documents.
  const docs = [];
  const pushDoc = (d, max) => {
    if (!d || typeof d.text !== "string" || d.text.length < 80) return;
    const url = normSpace(d.url).slice(0, 300);
    if (url && docs.some((x) => x.url === url)) return;
    docs.push({ title: normSpace(d.title).slice(0, 140), url,
      publisher: normSpace(d.publisher || d.site).slice(0, 80), text: String(d.text).slice(0, max) });
  };
  pushDoc(source, 3500);
  if (Array.isArray(sourceDocs)) sourceDocs.forEach((d) => { if (docs.length < 4) pushDoc(d, 1800); });

  // Search-hit metadata: keeps citations real even for pages that failed to scrape.
  const hits = (Array.isArray(sources) ? sources : [])
    .filter((s) => s && (s.title || s.url)).slice(0, 6)
    .map((s) => ({ title: normSpace(s.title).slice(0, 140), url: normSpace(s.url).slice(0, 300), publisher: normSpace(s.publisher).slice(0, 80) }));

  if (!topic && !docs.length) return res.status(400).json({ error: "Missing source material" });

  const slideCount = Math.min(12, Math.max(3, Number(options.slides) || 7));
  const styleName = normSpace(options.style) || "editorial";
  const platformName = normSpace(options.platform) || "instagram";

  const system = [
    "You are Carvv's editorial engine. You turn researched source material into a social-media carousel: a sequence of slide specifications, never prose.",
    'Return ONLY valid JSON (no markdown fences, no commentary) with this exact shape:\n{"title": string, "score": number, "sources": [{"publisher": string, "title": string, "url": string, "confidence": "high"|"medium"|"low"}], "slides": [SlideSpec]}',
    'SlideSpec = {\n"layout": one of "statement" "bar-chart" "line-chart" "comparison" "flywheel" "steps" "timeline" "map" "quote" "photo-hero" "photo-number" "annotated-shot" "closing",\n"purpose": one of "HOOK" "CONTEXT" "EVIDENCE" "EXPLANATION" "EXAMPLE" "INSIGHT" "CONCLUSION",\n"headline": string (max 90 chars; omit for quote slides),\n"body": string (max 220 chars) or null (prefer null),\n"data": chart payload for data layouts, else null. Shapes:\n  bar-chart: {"unit": string, "label": string, "series": [{"l": string, "v": number}]} (3-5 bars)\n  line-chart: {"unit": string, "label": string, "points": [{"l": string, "v": number}]} (3-6 points)\n  comparison: {"unit": string, "rows": [{"l": string, "v": number, "hi": true}]} (exactly 2 rows)\n  steps: {"steps": [{"t": string, "d": string}]} (3-4 steps)\n  timeline: {"items": [{"y": string, "t": string}]} (2-5 items)\n  map: {"flags": [{"n": string, "x": number 0-100, "y": number 0-100}]}\n  flywheel: {"nodes": [string]} (3-4 short labels),\n"quote": quotation text (required for layout "quote"), "who": attribution name, "role": attribution line,\n"big": short stat string like "61%" (only for layout "photo-number"),\n"foot": source credit like "Source: LBNL 2024" or null,\n"annot": one short chart annotation or null,\n"insight": one sentence: the editorial point of this beat,\n"why": one sentence: why this layout carries the point,\n"claims": [],\n"conf": "high" when facts come straight from the material, "medium" when inferred, "low" when generic}',
    "Rules:\n- Exactly " + slideCount + " slides. Slide 1 purpose \"HOOK\". Last slide purpose \"CONCLUSION\" with layout \"closing\".\n- Every statistic, date and quotation MUST come from the provided material or search results. Never invent numbers, quotes or URLs. If the material has no real number, use no data layout at all.\n- Vary the rhythm: no two adjacent slides share a layout.\n- \"sources\" lists only the provided SOURCE blocks / search results you actually used.\n- Visual style direction: " + styleName + ". Target platform: " + platformName + ".",
  ].join("\n\n");

  const userMsg = [
    inputType === "url" ? "The user gave a URL; its fetched page is SOURCE 1."
      : inputType === "topic" ? "The user gave a topic; live search results and fetched pages follow."
      : "The user pasted material; treat it as the primary source.",
    topic ? "Input: " + topic : null,
    docs.length
      ? docs.map((d, i) => "SOURCE " + (i + 1) + " [" + (d.publisher || d.url) + "] " + d.title + "\n" + d.url + "\n" + d.text).join("\n\n")
      : "No page could be fetched; work only from the input text and result metadata, and mark conf accordingly.",
    hits.length ? "Search results you may cite:\n" + hits.map((h, i) => "RESULT " + (i + 1) + ": " + h.title + " (" + h.publisher + ") " + h.url).join("\n") : null,
  ].filter(Boolean).join("\n\n");

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENROUTER_KEY}`,
        "http-referer": "https://carvv.app",
        "x-title": "Carvv",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      if (r.status === 429) return res.status(429).json({ error: "AI is rate limited right now. Wait a moment and retry." });
      return res.status(502).json({ error: `OpenRouter error (${r.status})`, detail: t.slice(0, 300) });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || "";
    let out;
    try { out = JSON.parse(content); } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { out = JSON.parse(m[0]); } catch { /* fall through */ } }
    }
    if (!out || !Array.isArray(out.slides) || out.slides.length < 3) {
      return res.status(502).json({ error: "Model returned unparseable output" });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "AI request failed" });
  }
});

app.listen(PORT, () => console.log(`carvv server on :${PORT} (ai: ${OPENROUTER_KEY ? "on" : "off"}, model: ${MODEL})`));
