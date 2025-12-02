import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET"]
}));

app.use(express.json());

// Serve static frontend
app.use(express.static("public"));

// Rate limiter (10s window, 20 req max)
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20,
});
app.use(limiter);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// GET /brain → return brain.json from Supabase storage
app.get("/brain", async (req, res) => {
  try {
    const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/brain/brain.json`;

    const resp = await fetch(fileUrl, {
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!resp.ok) {
      return res.status(500).json({
        error: "Failed to load brain.json",
        status: resp.status
      });
    }

    const data = await resp.text();
    res.setHeader("Content-Type", "application/json");
    res.send(data);

  } catch (err) {
    res.status(500).json({
      error: "Server error loading brain",
      detail: err.message
    });
  }
});

// /search → proxy to cube-search
app.get("/search", async (req, res) => {
  const q = req.query.q || "";

  try {
    const r = await fetch(`https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`);
    const json = await r.json();
    res.json(json);

  } catch (err) {
    res.status(500).json({
      error: "Search proxy failed",
      detail: err.message
    });
  }
});

// health endpoint
app.get("/_health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
