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

// ENHANCED SEARCH + EXTRACTION (top 5 URLs, bundled snippets, better fallbacks)
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  if (!process.env.EXA_KEY) {
    return res.status(500).json({ error: "EXA_KEY not configured" });
  }

  try {
    // Step 1: Search with bundled contents (basic text included)
    const searchRes = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
        "User-Agent": "CubeAI/1.0",
      },
      body: JSON.stringify({
        query: q,
        numResults: 10,  // More to pick from
        type: "auto",
        contents: true,  // ← NEW: Bundles basic extracted text in search response
      }),
    });

    if (!searchRes.ok) {
      const txt = await searchRes.text();
      console.error("Exa search error:", searchRes.status, txt.slice(0, 200));
      return res.status(502).json({ error: "Search failed" });
    }

    const searchData = await searchRes.json();
    const candidates = (searchData.results || [])
      .filter(r => r.url)  // Only valid URLs
      .slice(0, 5);  // Top 5 for extraction

    if (candidates.length === 0) {
      return res.json({ results: [] });
    }

    console.log(`Extracting from ${candidates.length} URLs for query: ${q}`);

    // Step 2: Deep extraction for top candidates (if bundled text is short)
    const topUrls = candidates.map(r => r.url);
    let fullContents = {};
    if (topUrls.length > 0) {
      const contentsRes = await fetch("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.EXA_KEY,
        },
        body: JSON.stringify({
          urls: topUrls,
          extract: {
            text: true,      // Full clean text
            highlights: true, // Key phrases
          },
        }),
      });

      if (contentsRes.ok) {
        const contentsData = await contentsRes.json();
        fullContents = (contentsData.contents || {}).reduce((acc, c) => {
          acc[c.url] = c;
          return acc;
        }, {});
        console.log(`Extracted content from ${Object.keys(fullContents).length}/${topUrls.length} URLs`);
      } else {
        console.error("Contents extraction failed:", contentsRes.status);
      }
    }

    // Step 3: Build results (prefer full text, fallback to bundled/search snippet)
    const results = candidates.map(item => {
      const full = fullContents[item.url] || {};
      const hasFullText = full.text && full.text.length > 100;  // Threshold for "good" extraction

      return {
        title: item.title || "Untitled",
        url: item.url,
        text: hasFullText 
          ? full.text.substring(0, 4000)  // Cap length for LLM
          : (item.text || item.snippet || "No content extracted – page may be dynamic or restricted"),
        snippet: item.text || item.snippet || "",  // Always include short version
        extracted: hasFullText,  // Flag for frontend
      };
    }).filter(r => r.text !== "No content extracted – page may be dynamic or restricted" || true);  // Keep all, but flag

    res.json({ results });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/_health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CubeAI server live on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
