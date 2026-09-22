/* ============================================================
   Carvv API server
   - GET  /api/health           liveness + capability flags
   - GET  /api/search?q=...     real web search, normalized results
   - GET  /api/scrape?url=...   fetch + strip a page (title, text, images)
   - POST /api/ai/story         story generation via OpenRouter
   The OpenRouter key lives ONLY here, in server env. The browser
   never sees it. In production this server also serves the client
   build from /dist, so the whole app is one deployable unit.
   ============================================================ */
import express from "express";
import * as cheerio from "cheerio";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8787);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Carvv/1.0";

/* ---------------------------------------------------------- headers + CORS
   Same-origin deploys and the Vite dev proxy need no CORS at all. When
   the client is hosted on a different origin, exactly one extra origin
   can be allowed via ALLOWED_ORIGIN. */
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("X-Frame-Options", "DENY");
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

/* ---------------------------------------------------------- tiny rate limit
   Fixed window, per IP, in memory. Enough to stop a hot loop or a bot
   from burning the OpenRouter quota; not a substitute for a WAF. */
const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.path}|${req.ip}`;
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n += 1;
    if (b.n > max) return res.status(429).json({ error: "Slow down a little, then try again." });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

/* ---------------------------------------------------------- health */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ai: Boolean(OPENROUTER_API_KEY), search: true, model: OPENROUTER_MODEL, ts: Date.now() });
});

/* ---------------------------------------------------------- fetch helper
   Real timeout on every call, and one retry on rate-limit (429) or a
   transient 5xx, so a flaky source doesn't sink a whole generation. */
async function fetchText(url, { timeoutMs = 12000, headers = {}, retry = true } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
      if (attempt === 0 && (resp.status === 429 || resp.status >= 500)) {
        await new Promise(r => setTimeout(r, 900));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") break;
      if (attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("fetch failed");
}

const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|::1)/i;
function checkedUrl(raw) {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error("bad protocol");
  if (PRIVATE_HOST.test(url.hostname)) throw new Error("private host");
  return url;
}

/* ---------------------------------------------------------- web search
   Real search, no API key: DuckDuckGo's HTML endpoint, parsed and
   normalized server-side. Ads and unusable links are dropped, results
   are deduped by host+path, and everything the client needs (title,
   url, snippet, publisher) is pre-cleaned. */
app.get("/api/search", rateLimit(60, 60000), async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 300);
  if (!q) return res.status(400).json({ error: "Missing q parameter." });
  try {
    const resp = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!resp.ok) return res.status(502).json({ error: `Search answered ${resp.status}.` });
    const html = (await resp.text()).slice(0, 1_500_000);
    const $ = cheerio.load(html);
    const out = [];
    const seen = new Set();
    $(".result").each((_i, el) => {
      if (out.length >= 8) return;
      const block = $(el);
      if (block.hasClass("result--ad")) return;
      const a = block.find(".result__a").first();
      const rawHref = a.attr("href") || "";
      let href = rawHref;
      try {
        const u = new URL(rawHref, "https://duckduckgo.com");
        href = u.searchParams.get("uddg") || rawHref;
      } catch { /* keep the raw href */ }
      let url;
      try { url = checkedUrl(href); } catch { return; }
      const title = a.text().replace(/\s+/g, " ").trim();
      const snippet = block.find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
      if (!title || seen.has(url.hostname + url.pathname)) return;
      seen.add(url.hostname + url.pathname);
      out.push({
        title: title.slice(0, 160),
        url: url.toString(),
        snippet: snippet.slice(0, 320),
        publisher: url.hostname.replace(/^www\./, ""),
      });
    });
    res.json({ query: q, results: out, fetchedAt: new Date().toISOString() });
  } catch (err) {
    const aborted = err?.name === "AbortError";
    res.status(aborted ? 504 : 502).json({ error: aborted ? "Search took too long." : "Search is unavailable right now." });
  }
});

/* ---------------------------------------------------------- scraping
   Real-time page retrieval: fetches a URL with a browser-grade user
   agent, strips chrome (nav/ads/cookie banners/scripts), and returns
   structured content: title, byline, date, reading text and images. */
app.get("/api/scrape", rateLimit(120, 60000), async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "Missing url parameter." });
  let url;
  try {
    url = checkedUrl(raw);
  } catch {
    return res.status(400).json({ error: "That URL is not fetchable." });
  }

  try {
    const resp = await fetchText(url.toString(), {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!resp.ok) return res.status(502).json({ error: `Source answered ${resp.status}.` });
    const type = resp.headers.get("content-type") || "";
    if (!type.includes("html")) return res.status(415).json({ error: "That URL is not a web page." });
    const html = (await resp.text()).slice(0, 2_000_000);

    const $ = cheerio.load(html);
    $("script,style,noscript,template,svg,iframe,nav,footer,form,aside,header,[role=banner],[role=navigation],[aria-modal=true]").remove();
    $("[class*=cookie],[id*=cookie],[class*=consent],[id*=consent],[class*=newsletter],[class*=paywall]").remove();

    const meta = (sel) => $(sel).attr("content") || "";
    const abs = (u) => { try { return u ? new URL(u, url).toString() : null; } catch { return null; } };
    const root = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
    const text = root.text().replace(/\s+/g, " ").trim().slice(0, 9000);
    const images = [];
    const og = abs(meta('meta[property="og:image"]'));
    if (og) images.push(og);
    $("img[src]").each((_i, el) => {
      const u = abs($(el).attr("src"));
      const w = Number($(el).attr("width") || 0);
      if (u && images.length < 8 && !/logo|icon|sprite|avatar|pixel/i.test(u) && (w === 0 || w >= 240)) images.push(u);
    });

    res.json({
      url: url.toString(),
      title: meta('meta[property="og:title"]') || $("title").first().text().trim() || url.hostname,
      site: meta('meta[property="og:site_name"]') || url.hostname.replace(/^www\./, ""),
      byline: meta('meta[name="author"]') || meta('meta[property="article:author"]') || null,
      published: meta('meta[property="article:published_time"]') || null,
      description: meta('meta[property="og:description"]') || meta('meta[name="description"]') || null,
      text,
      words: text ? text.split(" ").length : 0,
      images: [...new Set(images)],
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const aborted = err?.name === "AbortError";
    res.status(aborted ? 504 : 502).json({ error: aborted ? "The source took too long to answer." : "Could not fetch that page." });
  }
});

/* ---------------------------------------------------------- AI story
   The story architect. Sends the topic plus any REAL fetched material
   (scraped page, search hits) to the OpenRouter model and expects one
   strict JSON slide specification. */
const LAYOUTS = ["photo-hero", "photo-number", "statement", "bar-chart", "line-chart", "comparison", "flywheel", "steps", "timeline", "map", "quote", "annotated-shot", "closing"];
const PURPOSES = ["HOOK", "CONTEXT", "EVIDENCE", "EXPLANATION", "EXAMPLE", "INSIGHT", "CONCLUSION"];

const SYSTEM_PROMPT = `You are Carvv's story architect: an editor who turns source material into an Instagram/LinkedIn carousel specification.

Return ONLY a JSON object (no markdown, no commentary) with this exact shape:
{
  "title": string,                       // short project title, max 60 chars
  "score": number,                       // 0-100, how strong the story shape is
  "sources": [ { "publisher": string, "title": string, "confidence": "high"|"medium"|"low", "url": string|null } ],
  "slides": [ Slide ]
}

Slide = {
  "purpose": one of ${PURPOSES.join("|")},
  "layout": one of ${LAYOUTS.join("|")},
  "headline": string,                    // max 90 chars; may contain one "\n". Required except for layout "quote".
  "body": string|null,                   // 1-2 short sentences, plain words
  "data": null | one of:
      {"unit": string, "label": string, "series": [{"l": string, "v": number}]}   // bar-chart (3-6 bars)
    | {"unit": string, "label": string, "points": [{"l": string, "v": number}]}   // line-chart (4-8 points)
    | {"unit": string, "rows": [{"l": string, "v": number, "hi": boolean?}]}      // comparison (exactly 2 rows)
    | {"steps": [{"t": string, "d": string}]}                                     // steps (3-5)
    | {"items": [{"t": string, "d": string}]}                                     // timeline (3-5)
    | {"flags": [{"t": string, "d": string}]}                                     // map (2-4)
  "quote": string|null, "who": string|null, "role": string|null,   // only for layout "quote"
  "big": string|null,                    // oversized number text, only for "photo-number" (e.g. "12.6%")
  "foot": string|null,                   // source receipt line, e.g. "SEC 10-K FY2024"
  "annot": string|null,                  // short hand-written style margin note, lowercase
  "insight": string,                     // one line: the editorial point of this slide
  "why": string,                         // one line: why this layout was chosen
  "conf": "high"|"medium"|"low"
}

Rules that matter:
- First slide is always purpose HOOK and a visual-led layout (photo-hero, photo-number or quote).
- Last slide is purpose CONCLUSION with layout "closing".
- Only emit chart layouts (bar-chart, line-chart, comparison) when the source text contains real numbers to plot. Never invent statistics.
- If numbers exist in the material, prefer showing them over describing them.
- Vary layouts: no two adjacent slides may share a layout.
- When FETCHED SOURCE entries are provided in the material, cite exactly those (real publisher, real title, real url) in the top-level sources array. Do not cite sources you were not given.
- Kicker will be generated client-side; do not include one.`;

app.post("/api/ai/story", rateLimit(20, 60000), async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(501).json({ error: "AI is not configured on this server." });
  const { inputType = "topic", value = "", options = {}, source = null, sources = [] } = req.body || {};
  if (!String(value).trim() && !source && !(Array.isArray(sources) && sources.length)) {
    return res.status(400).json({ error: "Nothing to work with." });
  }

  /* Real fetched material beats the model's memory. Cap and sanitize it. */
  const material = [];
  if (source && typeof source === "object" && source.text) {
    material.push(`PRIMARY SOURCE TITLE: ${String(source.title || "").slice(0, 160)}\nPRIMARY SOURCE PUBLISHER: ${String(source.site || "").slice(0, 120)}\nPRIMARY SOURCE URL: ${String(source.url || "").slice(0, 300)}\nPRIMARY SOURCE TEXT:\n${String(source.text).slice(0, 6000)}`);
  }
  (Array.isArray(sources) ? sources : []).slice(0, 5).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    material.push(`FETCHED SOURCE ${i + 1}: ${String(s.title || "").slice(0, 160)} | publisher: ${String(s.publisher || "").slice(0, 120)} | url: ${String(s.url || "").slice(0, 300)}${s.snippet ? ` | snippet: ${String(s.snippet).slice(0, 320)}` : ""}`);
  });

  const n = options.auto ? 7 : Math.max(3, Math.min(12, Number(options.slides) || 7));
  const userMsg = [
    `Input type: ${inputType}`,
    `Platform: ${options.platform || "instagram"}`,
    `Visual style: ${options.style || "editorial"}`,
    `Requested slide count: ${n} (finish with exactly ${n} slides)`,
    options.template && options.template !== "auto" ? `Narrative shape to follow: ${options.template}` : "Choose the narrative shape yourself.",
    "",
    "Material:",
    material.length ? material.join("\n\n") + "\n\nUSER INPUT:\n" + String(value).slice(0, 2000) : String(value).slice(0, 6000),
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": req.headers.origin || "http://localhost:5173",
        "X-Title": "Carvv",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0.4,
        max_tokens: 4000,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMsg }],
      }),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      const code = resp.status === 429 ? 429 : 502;
      return res.status(code).json({ error: `OpenRouter answered ${resp.status}.`, detail });
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return res.status(502).json({ error: "The model returned no JSON." });
    let parsed;
    try { parsed = JSON.parse(content.slice(start, end + 1)); }
    catch { return res.status(502).json({ error: "The model returned malformed JSON." }); }
    if (!Array.isArray(parsed.slides) || parsed.slides.length < 3) return res.status(502).json({ error: "The model returned too few slides." });
    res.json(parsed);
  } catch (err) {
    res.status(err?.name === "AbortError" ? 504 : 502).json({ error: err?.name === "AbortError" ? "The model took too long." : "Story generation failed." });
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------------------------------------------------- static client (production) */
const dist = path.join(__dirname, "..", "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Carvv API on :${PORT} · ai=${OPENROUTER_API_KEY ? OPENROUTER_MODEL : "not configured"}`);
});
