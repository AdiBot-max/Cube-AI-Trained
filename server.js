/**
 * server.js
 * CubeAI — Turbo-V3 Markov generator + simple search proxy
 *
 * - Serves static files from /public
 * - GET /brain -> returns local brain.json
 * - POST /generate -> markov-based generation (prefers ^START keys)
 * - GET /search?q=... -> proxies to cube-search.onrender.com (single-homepage)
 *
 * Start: node server.js
 */

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

// Basic rate limiter
app.use(rateLimit({
  windowMs: 10_000,
  max: 40,
}));

/* -------------------------
   Brain + MARKOV state
   ------------------------- */
let BRAIN = { intents: {} };
let MARKOV = { order: 2, map: new Map() };

function safeLoadBrain() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    const parsed = JSON.parse(raw);
    BRAIN = parsed.brain || parsed || { intents: {} };
    buildMarkov(BRAIN);
    console.log("Brain loaded. intents:", Object.keys(BRAIN.intents || {}).length);
  } catch (err) {
    console.error("Failed to load brain.json:", err.message);
    BRAIN = { intents: {} };
    MARKOV = { order: 2, map: new Map() };
  }
}

// Build an order-2 Markov map from each intent.examples (multi-line allowed)
function buildMarkov(brain) {
  const order = 2;
  const map = new Map();

  function feedText(text) {
    if (!text || typeof text !== "string") return;
    // split to words but preserve punctuation tokens as separate tokens
    const tokens = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (!tokens.length) return;
    const padded = ["^START", ...tokens, "^END"];
    for (let i = 0; i <= padded.length - order; i++) {
      const key = padded.slice(i, i + order).join("\u0001");
      const next = padded[i + order] || "^END";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(next);
    }
  }

  // feed examples (multi-line strings)
  for (const intent of Object.values(brain.intents || {})) {
    const examples = intent.examples || [];
    for (const ex of examples) feedText(String(ex));
  }

  MARKOV = { order, map };
  console.log("Markov built - keys:", MARKOV.map.size);
}

// Improved generator: always starts from ^START keys when possible to preserve first word
function generateMarkov(prompt = "", maxTokens = 60) {
  if (!MARKOV || !MARKOV.map || MARKOV.map.size === 0) return "I don't know yet — try web search.";

  const { order, map } = MARKOV;
  const tokens = (String(prompt || "")).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  // choose start keys that truly represent beginnings: ^START\u0001<word>
  const startKeys = [...map.keys()].filter(k => k.startsWith("^START\u0001"));
  let key;

  if (tokens.length >= order) {
    const candidate = tokens.slice(tokens.length - order).join("\u0001");
    key = map.has(candidate) ? candidate : (startKeys.length ? startKeys[Math.floor(Math.random() * startKeys.length)] : [...map.keys()][Math.floor(Math.random() * map.size)]);
  } else {
    key = startKeys.length ? startKeys[Math.floor(Math.random() * startKeys.length)] : [...map.keys()][Math.floor(Math.random() * map.size)];
  }

  const out = [];
  for (let i = 0; i < maxTokens; i++) {
    const choices = map.get(key);
    if (!choices || choices.length === 0) break;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    if (pick === "^END") break;
    out.push(pick);
    // advance frame: drop first token, push pick
    const parts = key.split("\u0001").slice(1);
    parts.push(pick);
    key = parts.join("\u0001");
  }

  // Join and cleanup spacing around punctuation
  let sentence = out.join(" ").replace(/\s+([.,!?;:])/g, "$1").trim();
  if (!sentence) return "I don't have enough data to compose a reply yet.";
  return sentence;
}

/* -------------------------
   Initial load + watch
   ------------------------- */
safeLoadBrain();
try {
  fs.watchFile(path.join(__dirname, "brain.json"), { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log("brain.json changed — reloading");
      safeLoadBrain();
    }
  });
} catch (e) {
  console.warn("fs.watchFile may be restricted: ", e.message);
}

/* -------------------------
   Routes
   ------------------------- */

// Serve raw brain.json
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json", detail: err.message });
  }
});

// Generate endpoint
app.post("/generate", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const max = Math.min(200, Number(req.body?.maxTokens || 60));

    // quick intent detection: if prompt includes a trigger, use a random example as seed, then generate continuation
    const lower = prompt.toLowerCase();
    for (const [iname, intent] of Object.entries(BRAIN.intents || {})) {
      for (const trig of (intent.triggers || [])) {
        if (!trig) continue;
        if (lower.includes(String(trig).toLowerCase())) {
          const examples = intent.examples || [];
          if (examples.length) {
            const seed = examples[Math.floor(Math.random() * examples.length)];
            const cont = generateMarkov(seed, Math.max(12, Math.floor(max / 3)));
            return res.json({ type: "intent", intent: iname, reply: seed + (cont ? ("\n\n" + cont) : "") });
          }
        }
      }
    }

    // fallback: generate from prompt seed
    const out = generateMarkov(prompt, max);
    res.json({ type: "generate", reply: out });
  } catch (err) {
    console.error("generate error:", err.stack || err.message);
    res.status(500).json({ error: "Generation failed", detail: err.message });
  }
});

// Search proxy — single homepage semantics (keeps link same)
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q parameter" });

  try {
    // cube-search is a single page — call root and return snippet
    const upstream = `https://cube-search.onrender.com?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream, { method: "GET", headers: { "User-Agent": "CubeAI/1.0" }, timeout: 10000 });
    const contentType = (r.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const j = await r.json();
      return res.json(j);
    }
    const text = await r.text();
    const snippet = text.replace(/\s+/g, " ").slice(0, 2000);
    return res.json({ results: [{ title: `Search results for "${q}" (cube-search)`, url: "https://cube-search.onrender.com", text: snippet }] });
  } catch (err) {
    console.error("Search proxy error:", err.message);
    return res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/_health", (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CubeAI server listening on ${PORT}`);
});
