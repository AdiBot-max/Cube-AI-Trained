import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";

const app = express();

app.set("trust proxy", 1); // REQUIRED FOR RENDER

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());
app.use(express.static("public"));

// rate limiter
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 20
});
app.use(limiter);

// serve brain.json from local
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync("./brain.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (e) {
    res.status(500).json({ error: "Failed to load brain.json", detail: e.message });
  }
});

// proxy search
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  try {
    const r = await fetch(`https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: "Search proxy failed", detail: err.message });
  }
});

// health
app.get("/_health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
