import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";
import cheerio from "cheerio";

const app = express();

// Required for rate limiter on Render
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.static("public"));

// Rate limiter: 20 req per 10s
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
});
app.use(limiter);

// --------------------------------------------------------------------------
// Serve brain.json from local root
// --------------------------------------------------------------------------
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync("./brain.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (e) {
    res.status(500).json({ error: "Failed to load brain.json", detail: e.message });
  }
});

// --------------------------------------------------------------------------
// Proxy search to cube-search API
// --------------------------------------------------------------------------
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.status(400).json({ error: "Missing q parameter" });

  try {
    const r = await fetch(`https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: "Search proxy failed", detail: err.message });
  }
});

// --------------------------------------------------------------------------
// Extract top text from a web page (knowledge extraction)
// --------------------------------------------------------------------------
app.get("/extract", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const html = await (await fetch(url)).text();
    const $ = cheerio.load(html);

    // Try meta description first, then first <p>, else slice body
    let answer =
      $('meta[name="description"]').attr("content") ||
      $("p").first().text() ||
      $("body").text().slice(0, 300);

    answer = answer.replace(/\s+/g, " ").trim();

    return res.json({
      answer: answer.slice(0, 350),
      title: $("title").text().trim() || url
    });
  } catch (err) {
    res.json({ answer: null, title: null });
  }
});

// --------------------------------------------------------------------------
// Health check
// --------------------------------------------------------------------------
app.get("/_health", (req, res) => res.json({ ok: true }));

// --------------------------------------------------------------------------
// Start server
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
