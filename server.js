import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());
app.use(express.static("public"));

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20
});
app.use(limiter);

// Load brain.json locally
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync("./brain.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json", detail: err.message });
  }
});

// New EXA Search Endpoint
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  try {
    const response = await fetch(`https://api.exa.ai/search?q=${encodeURIComponent(q)}`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.EXA_KEY
      }
    });

    const data = await response.json();
    const items = (data.results || []).map(r => ({
      title: r.title,
      text: r.snippet || "",
      url: r.url
    }));

    res.json({ results: items });
  } catch (err) {
    console.error("EXA error:", err);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/_health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
