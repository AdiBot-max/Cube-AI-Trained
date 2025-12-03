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

const limiter = rateLimit({
  windowMs: 10_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Serve brain.json
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json", detail: err.message });
  }
});

// WORKING EXA SEARCH – DECEMBER 2025 (no /v1, correct syntax)
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q parameter" });

  if (!process.env.EXA_KEY) {
    console.error("EXA_KEY missing");
    return res.status(500).json({ error: "Search unavailable – missing API key" });
  }

  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        query: q,
        numResults: 10,
        text: true,
        highlights: true,
        type: "auto",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Exa API error ${response.status}:`, text.slice(0, 300));
      return res.status(502).json({ error: `Exa API error ${response.status}` });
    }

    const data = await response.json();

    const items = (data.results || []).map((r) => ({
      title: r.title || "No title",
      text: r.text || r.snippet || "",
      url: r.url || "#",
    }));

    res.json({ results: items });
  } catch (err) {
    console.error("Search failed:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// Health check
app.get("/_health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
