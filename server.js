import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.static("public"));

app.use(rateLimit({
  windowMs: 10_000,
  max: 20,
}));

app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json" });
  }
});

// BULLETPROOF SEARCH + EXTRACTION (2025-SAFE, NO CRASHES)
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  if (!process.env.EXA_KEY) {
    return res.status(500).json({ error: "EXA_KEY not configured" });
  }

  console.log(`Starting search for: "${q}"`);

  try {
    // Step 1: Search (with snippets for fallback)
    const searchRes = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
        "User-Agent": "CubeAI/1.0",
      },
      body: JSON.stringify({
        query: q,
        numResults: 10,  // Balanced for quota
        text: true,      // Bundled snippets
        highlights: true,
        type: "auto",
      }),
    });

    if (!searchRes.ok) {
      const txt = await searchRes.text();
      console.error("Exa search failed:", searchRes.status, txt.slice(0, 200));
      return res.status(502).json({ error: `Search API error ${searchRes.status}` });
    }

    const searchData = await searchRes.json();
    console.log(`Search returned ${searchData.results?.length || 0} results`);

    const candidates = (searchData.results || [])
      .filter(r => r.url && r.url.startsWith('http'))  // Strict URL filter
      .slice(0, 3);  // Top 3 only (quota-friendly)

    if (candidates.length === 0) {
      console.log("No valid candidates found");
      return res.json({ results: [] });
    }

    console.log(`Extracting from ${candidates.length} URLs`);

    // Step 2: Extraction (safe handling)
    const topUrls = candidates.map(r => r.url);
    let fullContents = {};
    if (topUrls.length > 0) {
      // Tiny delay for rate limits
      await new Promise(r => setTimeout(r, 1000));

      const contentsRes = await fetch("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.EXA_KEY,
        },
        body: JSON.stringify({
          urls: topUrls,
          extract: {
            text: true,
            highlights: true,
          },
        }),
      });

      if (!contentsRes.ok) {
        const txt = await contentsRes.text();
        console.error("Exa contents failed:", contentsRes.status, txt.slice(0, 200));
        // Don't crash – proceed with snippets
      } else {
        const contentsData = await contentsRes.json();
        // Safe access: contents is array of {url, text, ...}
        fullContents = (contentsData.contents || []).reduce((acc, c) => {
          if (c.url && c.text) {
            acc[c.url] = c;
          }
          return acc;
        }, {});
        console.log(`Extracted full text from ${Object.keys(fullContents).length}/${topUrls.length} URLs`);
      }
    }

    // Step 3: Build results (full > snippet > minimal fallback)
    const results = candidates.map(item => {
      const full = fullContents[item.url] || {};
      let textContent = "";
      if (full.text && full.text.trim().length > 150) {
        textContent = full.text.substring(0, 3000).trim();  // Cap & clean
      } else if (item.text && item.text.trim().length > 50) {
        textContent = item.text.trim();
      } else {
        textContent = `Brief summary: ${item.snippet?.substring(0, 500) || 'Content limited (dynamic page or quota). Check the URL for details.'}`;
      }

      return {
        title: item.title?.trim() || "Untitled",
        url: item.url,
        text: textContent,
        snippet: item.text?.trim() || item.snippet?.trim() || "",
        extracted: !!full.text,  // Boolean flag
        highlights: full.highlights || item.highlights || [],
      };
    });

    console.log(`Returning ${results.length} results for "${q}"`);
    res.json({ results });

  } catch (err) {
    console.error("Unhandled search error:", err.message, err.stack?.split('\n')[0]);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/_health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CubeAI server live on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
