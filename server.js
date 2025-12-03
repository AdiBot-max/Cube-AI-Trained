// server.js (ESM)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";
import { load as cheerioLoad } from "cheerio";

const app = express();

// required for Render and correct rate-limit IP handling
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.static("public"));

// basic rate limiter
const limiter = rateLimit({
  windowMs: 10 * 1000, // 10s
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// helper: safe fetch with timeout
async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// load local brain.json if present
app.get("/brain", (req, res) => {
  try {
    const path = "./brain.json";
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf8");
      res.setHeader("Content-Type", "application/json");
      return res.send(raw);
    }
    // If you prefer to fetch from Supabase, implement it here
    return res.status(404).json({ error: "brain.json not found on server" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to load brain.json", detail: e.message });
  }
});

// proxy + extraction: call cube-search, then fetch & extract pages
app.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q parameter" });

  try {
    // 1) call cube-search (always same host)
    const searchUrl = `https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`;
    const searchResp = await fetchWithTimeout(searchUrl, {}, 8000);
    if (!searchResp.ok) {
      const txt = await searchResp.text().catch(() => "");
      return res.status(502).json({ error: "Upstream search failed", status: searchResp.status, info: txt });
    }
    const searchJson = await searchResp.json();
    const items = Array.isArray(searchJson.results) ? searchJson.results.slice(0, 6) : [];

    // 2) For each result, fetch the page and extract readable text
    const fetched = await Promise.all(items.map(async (it) => {
      const out = {
        title: it.title || "",
        url: it.url || "",
        snippet: it.text || it.snippet || "",
        extracted: "",
        extractedSentences: [],
        error: null
      };

      if (!it.url) return out;

      try {
        const pageResp = await fetchWithTimeout(it.url, { headers: { "User-Agent": "CubeAI/1.0 (+https://cube-search.onrender.com)" } }, 8000);
        if (!pageResp.ok) {
          out.error = `Failed to fetch (${pageResp.status})`;
          return out;
        }
        const html = await pageResp.text();

        // cheerio extraction
        const $ = cheerioLoad(html);

        // get meta description first
        const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || "";

        // gather title (prefer search title then page title)
        if (!out.title) out.title = $('title').first().text().trim() || out.title;

        // gather paragraphs & headings in order until we have enough text
        const nodes = [];
        $('article p, p, h1, h2, h3').each((i, el) => {
          const t = $(el).text().trim();
          if (t && t.length > 20) nodes.push(t);
        });

        // Fallback: collect visible text from body (split by blocks)
        if (nodes.length === 0) {
          const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
          if (bodyText.length > 50) nodes.push(bodyText.slice(0, 500));
        }

        // Prepare extracted text
        const combined = (metaDesc ? (metaDesc + "\n\n") : "") + nodes.join("\n\n");
        out.extracted = combined;

        // split to sentences (naive sentence split)
        const sentenceSplit = combined
          .replace(/\n+/g, '. ')
          .split(/(?<=[.?!])\s+/)
          .map(s => s.trim())
          .filter(Boolean);

        out.extractedSentences = sentenceSplit.slice(0, 12); // keep first few sentences
        return out;
      } catch (err) {
        out.error = err.name === "AbortError" ? "Timeout" : (err.message || "fetch error");
        return out;
      }
    }));

    // 3) Summarize adaptively per result & build final payload
    function needsLongAnswer(query) {
      const q = query.toLowerCase();
      return /\b(explain|why|how|describe|difference|what happens|what is happening|detail|tell me about)\b/.test(q);
    }
    const long = needsLongAnswer(q);

    const results = fetched.map((f, i) => {
      // prefer explicit snippet from cube-search if extraction failed
      const sourceSnippet = f.extractedSentences.length ? f.extractedSentences.join(' ') : (f.snippet || "");
      // produce adaptive summary:
      let summary = "";
      if (!sourceSnippet) {
        summary = items[i].text || "No extractable text from source.";
      } else {
        // short vs long
        if (long) {
          // longer: 3-6 sentences (or up to available)
          summary = f.extractedSentences.slice(0, 5).join(' ');
        } else {
          // short: 1-2 sentences
          summary = f.extractedSentences.slice(0, 2).join(' ');
        }
      }

      return {
        title: f.title || items[i].title || "",
        url: items[i].url || f.url || "",
        searchSnippet: items[i].text || items[i].snippet || "",
        extracted: f.extracted || "",
        summary: summary || (items[i].text || "").slice(0, 250),
        error: f.error || null
      };
    });

    // 4) Choose best result for immediate chat reply (first result with summary)
    const best = results.find(r => r.summary && !r.error) || results[0] || null;
    const chatAnswer = best ? best.summary : "No useful results extracted.";

    return res.json({
      query: q,
      bestAnswer: chatAnswer,
      results
    });

  } catch (err) {
    console.error("/search error:", err);
    return res.status(500).json({ error: "Server error during search", detail: err.message });
  }
});

// health
app.get("/_health", (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
