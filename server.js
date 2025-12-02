import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();

// File path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors({
  origin: "*",
  methods: ["GET"]
}));

app.use(express.json());

// Serve static frontend
app.use(express.static("public"));

// Rate limiter
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 20,
}));

// GET /brain → load brain.json from local filesystem
app.get("/brain", (req, res) => {
  const filePath = path.join(__dirname, "brain.json");

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).json({
        error: "Failed to load brain.json",
        detail: err.message
      });
    }

    res.setHeader("Content-Type", "application/json");
    res.send(data);
  });
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

// health
app.get("/_health", (req, res) => res.json({ ok: true }));

// SPA fallback (optional)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
