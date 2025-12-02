import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// IMPORTANT for Render reverse proxy
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());
app.use(express.static("public"));

// Rate limit
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 20,
}));

// === GET /brain ===
app.get("/brain", (req, res) => {
  const filePath = path.join(__dirname, "brain.json");

  console.log("Loading brain.json from:", filePath);

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read brain.json:", err);
      return res.status(500).json({ error: "brain.json read error" });
    }

    try {
      JSON.parse(data);  // validate JSON
    } catch (e) {
      console.error("Invalid JSON in brain.json:", e);
      return res.status(500).json({ error: "Invalid brain JSON" });
    }

    res.setHeader("Content-Type", "application/json");
    res.send(data);
  });
});

// === SEARCH ===
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  try {
    const r = await fetch(`https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: "search proxy failed" });
  }
});

// health
app.get("/_health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
