import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

const app = express();
app.use(cors());
app.use(express.json());

// rate limiter (basic)
const limiter = rateLimit({
  windowMs: 10 * 1000, // 10s
  max: 20, // max 20 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const SUPABASE_URL = process.env.SUPABASE_URL;   // e.g. https://abcd.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_KEY;   // service_role or anon depending on bucket setup

if (!SUPABASE_URL) console.warn("SUPABASE_URL not set");
if (!SUPABASE_KEY) console.warn("SUPABASE_KEY not set");

// GET /brain -> returns brain.json text
app.get("/brain", async (req, res) => {
  try {
    const fileUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/brain/brain.json`;

    const response = await fetch(fileUrl, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      const info = await response.text().catch(() => "");
      return res.status(502).json({ error: "Failed to fetch brain.json from Supabase", status: response.status, info });
    }

    const data = await response.text();
    res.setHeader("Content-Type", "application/json");
    return res.send(data);

  } catch (err) {
    console.error("Error /brain:", err);
    return res.status(500).json({ error: "Server error fetching brain.json", details: err.message });
  }
});

// Optional: proxy search to cube-search.onrender.com to avoid client CORS issues
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.status(400).json({ error: "Missing q param" });

  try {
    const url = `https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text().catch(()=>"");
      return res.status(502).json({ error: "Search upstream error", status: r.status, info: txt });
    }
    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error("Error /search:", err);
    return res.status(500).json({ error: "Server error proxying search", details: err.message });
  }
});

// health
app.get("/_health", (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on http://0.0.0.0:${PORT}`));
