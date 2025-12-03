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

// SEARCH + EXTRACT FULL TEXT FROM BEST PAGES
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  if (!process.env.EXA_KEY) {
    return res.status(500).json({ error: "EXA_KEY not configured" });
  }

  try {
    // Step 1: Search
    const searchRes = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
        "User-Agent": "CubeAI/1.0",
      },
      body: JSON.stringify({
        query: q,
        numResults: 8,
        type: "auto",
      }),
    });

    if (!searchRes.ok) {
      const txt = await searchRes.text();
      console.error("Exa search error:", searchRes.status, txt.slice(0, 200));
      return res.status(502).json({ error: "Search failed" });
    }

    const searchData = await searchRes.json();
    const topUrls = (searchData.results || [])
      .slice(0, 3) // take top 3
      .map(r => r.url)
      .filter(Boolean);

    if (topUrls.length === 0) {
      return res.json({ results: [] });
    }

    // Step 2: Get clean extracted text from those URLs
    const contentsRes = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
      },
      body: JSON.stringify({
        urls: topUrls,
        // these options give the cleanest readable text
        extract: {
          text: true,
          highlights: true,
          summary: false,
        },
      }),
    });

    if (!contentsRes.ok) {
      console.error("Exa contents error:", contentsRes.status);
      // fall back to just search results if contents fails
      return res.json({
        results: searchData.results.slice(0, 5).map(r => ({
          title: r.title || "Untitled",
          text: r.text || "",
          url: r.url,
        })),
      });
    }

    const contentsData = await contentsRes.json();

    // Merge search metadata with extracted full text
    const results = topUrls.map(url => {
      const searchItem = searchData.results.find(r => r.url === url) || {};
      const contentItem = contentsData.contents?.find(c => c.url === url) || {};

      return {
        title: searchItem.title || "Untitled",
        url: url,
        text: contentItem.text || contentItem.extractedText || searchItem.text || "No content extracted",
        snippet: searchItem.text || "",
      };
    });

    res.json({ results });

  } catch (err) {
    console.error("Unexpected search error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/_health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CubeAI server live on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
