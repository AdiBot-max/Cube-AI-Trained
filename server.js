import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";

const app = express();

app.set("trust proxy", 1); // Required for Render

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());
app.use(express.static("public"));

// Rate limit (20 req / 10 seconds)
app.use(
  rateLimit({
    windowMs: 10 * 1000,
    max: 20
  })
);

// Load brain.json locally
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync("./brain.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    res.status(500).json({
      error: "Failed to load brain.json",
      detail: err.message
    });
  }
});

// Smart search proxy with automatic fallback
app.get("/search", async (req, res) => {
  const q = req.query.q || "";

  if (!q.trim()) {
    return res.json({ results: [] });
  }

  const upstream = `https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`;

  try {
    const r = await fetch(upstream, {
      headers: {
        "User-Agent": "CubeAI/1.0"
      }
    });

    const text = await r.text();
    let jsonData;

    // Try JSON first → if fails, wrap raw result
    try {
      jsonData = JSON.parse(text);
    } catch {
      jsonData = {
        results: [
          {
            title: "Facing difficulty reading results",
            excerpt: text.slice(0, 200),
            url: upstream
          }
        ]
      };
    }

    // Ensure consistent shape
    if (!Array.isArray(jsonData.results)) {
      jsonData.results = [];
    }

    res.json(jsonData);

  } catch (err) {
    // Fallback response
    res.json({
      results: [
        {
          title: "Search unavailable",
          excerpt: "Cube-search service did not respond.",
          url: "https://cube-search.onrender.com/"
        }
      ]
    });
  }
});

// Health check
app.get("/_health", (req, res) => res.json({ ok: true }));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
