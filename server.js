import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Fix path resolution in ESM

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set("trust proxy", 1);
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.use(express.static("public"));

// Rate limiter: 20 requests per 10 seconds (same as before)
const limiter = rateLimit({
  windowMs: 10 * 1000,
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

// FIXED EXA SEARCH – WORKING 2025 VERSION
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  if (!process.env.EXA_KEY) {
    console.error("EXA_KEY not set in environment variables");
    return res.status(500).json({ error: "Server misconfigured (missing EXA_KEY)" });
  }

  try {
    const response = await fetch("https://api.exa.ai/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY, // ← your key in Render env
      },
      body: JSON.stringify({
        query: q,
        numResults: 10,
        useAutoprompt: false,
        // you can add includeDomains/excludeDomains here if you want
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Exa API error:", response.status, errorText);
      throw new Error(`Exa API returned ${response.status}`);
    }

    const data = await response.json();

    // Normalize results to the format your frontend expects
    const items = (data.results || []).map(r => ({
      title: r.title || "Untitled",
      text: r.snippet || r.text || "",
      url: r.url || "#",
    }));

    res.json({ results: items });

  } catch (err) {
    console.error("EXA search failed:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// Health check
app.get("/_health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
