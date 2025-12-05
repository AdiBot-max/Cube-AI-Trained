/**
 * server.js
 * Lightweight CubeAI server for Render (512MB-friendly)
 * - Serves static files from /public
 * - GET /brain -> returns local brain.json
 * - GET /search?q=... -> proxies to cube-search.onrender.com (homepage-based)
 * - POST /generate -> tiny Markov generator built from brain.json
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

// basic rate limiter
app.use(rateLimit({
  windowMs: 10_000,
  max: 30
}));

// Load / watch brain.json at startup
let BRAIN = null;
let MARKOV = null;

function safeReadBrain() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    const data = JSON.parse(txt);
    BRAIN = data.brain || data; // support both full wrapper or raw
    buildMarkovFromBrain(BRAIN);
    console.log("Brain loaded. Intents:", Object.keys(BRAIN.intents || {}).length);
  } catch (err) {
    console.error("Failed to load brain.json:", err.message);
    BRAIN = { intents: {} };
    MARKOV = { order: 2, map: {} };
  }
}

// Simple order-2 Markov chain built from triggers + responses
function buildMarkovFromBrain(brain) {
  const order = 2;
  const map = new Map();

  function feedText(s) {
    if (!s || typeof s !== "string") return;
    // normalize and split into tokens (words + punctuation)
    const tokens = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (tokens.length < 1) return;
    // add start token
    const padded = ["^START", ...tokens, "^END"];
    for (let i = 0; i <= padded.length - order - 0; i++) {
      const key = padded.slice(i, i + order).join("\u0001"); // join with unlikely char
      const next = padded[i + order] || "^END";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(next);
    }
  }

  // feed triggers and responses
  for (const [name, intent] of Object.entries(brain.intents || {})) {
    (intent.triggers || []).forEach(t => feedText(String(t)));
    (intent.responses || []).forEach(r => feedText(String(r)));
  }

  MARKOV = { order, map };
}

// generate based on prompt (seed) with small safety caps
function generateFromMarkov(prompt = "", maxTokens = 40) {
  if (!MARKOV || !MARKOV.map || MARKOV.map.size === 0) return "I don't know yet — try web search.";
  const { order, map } = MARKOV;
  // seed tokens
  const seedTokens = (prompt || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let startFrame;
  if (seedTokens.length >= order) {
    startFrame = seedTokens.slice(seedTokens.length - order, seedTokens.length).join("\u0001");
  } else {
    // pick a random key that contains start tokens if possible
    const startKeys = [...map.keys()].filter(k => k.startsWith("^START"));
    startFrame = startKeys.length ? startKeys[Math.floor(Math.random() * startKeys.length)] : [...map.keys()][Math.floor(Math.random() * map.size)];
  }

  const out = [];
  let cur = startFrame;
  for (let i = 0; i < maxTokens; i++) {
    const choices = map.get(cur);
    if (!choices || choices.length === 0) break;
    // weighted random pick
    const pick = choices[Math.floor(Math.random() * choices.length)];
    if (pick === "^END") break;
    out.push(pick);
    // advance frame
    const parts = cur.split("\u0001").slice(1); // drop first
    parts.push(pick);
    cur = parts.join("\u0001");
  }

  // postprocess: join and clean
  const sentence = out.join(" ").replace(/\s+([.,!?;:])/g, "$1").trim();
  if (!sentence) return "I don't have enough data to compose a reply yet.";
  return sentence;
}

// initial load
safeReadBrain();

// auto-reload brain.json if file changes (useful during dev)
try {
  fs.watchFile(path.join(__dirname, "brain.json"), { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log("brain.json changed — reloading");
      safeReadBrain();
    }
  });
} catch (e) {
  // ignore in environments where fs.watchFile is restricted
}

// GET /brain -> raw brain.json text
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: "Failed to load brain.json", detail: err.message });
  }
});

// POST /generate -> { prompt, maxTokens } => generated text
app.post("/generate", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const max = Math.min(120, Number(req.body?.maxTokens || 40));
    // quick intent check: if prompt exactly matches an intent trigger, prefer a response
    const lower = prompt.toLowerCase();
    for (const [iname, intent] of Object.entries(BRAIN.intents || {})) {
      for (const trig of (intent.triggers || [])) {
        if (!trig) continue;
        if (lower.includes(String(trig).toLowerCase())) {
          // choose a response and also allow generation after it
          const respList = intent.responses || [];
          if (respList.length > 0) {
            const pick = respList[Math.floor(Math.random() * respList.length)];
            // return a generated continuation appended to picked response
            const cont = generateFromMarkov(pick, Math.max(10, Math.floor(max / 3)));
            return res.json({ type: "intent", intent: iname, reply: pick + (cont ? ("\n" + cont) : "") });
          }
        }
      }
    }
    // fallback: generate from markov using prompt as seed
    const out = generateFromMarkov(prompt, max);
    res.json({ type: "generate", reply: out });
  } catch (err) {
    console.error("generate error:", err.stack || err.message);
    res.status(500).json({ error: "Generation failed", detail: err.message });
  }
});

// /search proxy -> cube-search.onrender.com (single-page endpoint)
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q parameter" });
  try {
    // cube-search onrender.com has a single homepage. We'll call it with ?q=... and accept JSON or HTML.
    const upstream = `https://cube-search.onrender.com?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream, { method: "GET", headers: { "User-Agent": "CubeAI/1.0" }, timeout: 10_000 });
    const contentType = r.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const j = await r.json();
      return res.json(j);
    }
    const text = await r.text();
    // Best-effort extraction: create small result object with title and snippet.
    // Keep link the same (homepage) as you requested.
    const snippet = text.replace(/\s+/g, " ").slice(0, 1600);
    return res.json({ results: [{ title: `Search results for "${q}" (from cube-search)`, url: "https://cube-search.onrender.com", text: snippet }]});
  } catch (err) {
    console.error("Search proxy error:", err.message);
    return res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

// health
app.get("/_health", (req, res) => res.json({ ok: true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CubeAI server listening on ${PORT}`);
});
