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
  windowMs: 10 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    res.type("application/json").send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json", detail: err.message });
  }
});

app.get("/search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  if (!process.env.EXA_KEY) {
    return res.status(500).json({ error: "Server misconfigured (missing EXA_KEY)" });
  }

  try {
    // Tiny delay to appease Cloudflare (optional)
    await new Promise(r => setTimeout(r, 500));

    const response = await fetch("https://api.exa.ai/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({
        query: q,
        numResults: 10,
        useAutoprompt: false
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Exa API error:", response.status, errorText.substring(0, 200) + "...");
      throw new Error(`Exa API returned ${response.status}`);
    }

    const data = await response.json();
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

app.get("/_health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`EXA_KEY ${process.env.EXA_KEY ? "present" : "MISSING"}`);
});
