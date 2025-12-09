/**
 * server.js
 * CubeAI — 4-response pipeline + keyword-aware generator (Option C)
 *
 * Routes:
 *  - GET /brain        -> returns brain.json
 *  - POST /generate    -> { prompt, maxTokens } => { candidates: [...], chosenIndex, chosen }
 *  - GET  /search?q=.. -> proxy cube-search (keeps homepage URL as requested)
 *
 * Generation pipeline:
 *  - 1) Build lightweight Markov from intent examples
 *  - 2) Create 4 candidate responses using different strategies:
 *      A: Markov continuation from prompt
 *      B: Template joiner using intent keywords
 *      C: Example + short Markov continuation
 *      D: Keyword-focused short summary
 *  - 3) Score candidates using keyword overlap, length and novelty heuristics
 *  - 4) Return candidates + chosen response
 *
 * Note: This is deterministic-probabilistic but entirely local/safe.
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

app.use(rateLimit({
  windowMs: 10_000,
  max: 60
}));

/* -------------------------
   Brain + Markov state
   ------------------------- */
let RAW = null;         // full parsed brain.json
let BRAIN = { intents: {} };  // normalized
let GLOBAL_KEYWORDS = {};     // keywords_global
let MARKOV = { order: 2, map: new Map() };

/* -------------------------
   Helpers: safe load brain
   ------------------------- */
function loadBrain() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    RAW = JSON.parse(txt);
    BRAIN = RAW.brain || RAW;
    GLOBAL_KEYWORDS = RAW.keywords_global || RAW.keywords_global || {};
    buildMarkovFromExamples(BRAIN);
    console.log("Brain loaded — intents:", Object.keys(BRAIN.intents || {}).length);
  } catch (e) {
    console.error("Failed to load brain.json:", e.message);
    RAW = null;
    BRAIN = { intents: {} };
    GLOBAL_KEYWORDS = {};
    MARKOV = { order: 2, map: new Map() };
  }
}

/* -------------------------
   Build Markov from examples
   ------------------------- */
function buildMarkovFromExamples(brain) {
  const order = 2;
  const map = new Map();

  function feed(text) {
    if (!text || typeof text !== "string") return;
    const words = text
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (words.length === 0) return;
    const pad = ["^START", ...words, "^END"];
    for (let i = 0; i <= pad.length - order - 1; i++) {
      const key = pad.slice(i, i + order).join("\u0001");
      const next = pad[i + order];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(next);
    }
  }

  // feed all intent examples (preferred) and responses if no examples
  for (const intent of Object.values(brain.intents || {})) {
    (intent.examples || []).forEach(e => feed(String(e)));
    if ((!intent.examples || intent.examples.length === 0) && intent.responses) {
      (intent.responses || []).forEach(r => feed(String(r)));
    }
  }

  MARKOV = { order, map };
}

/* -------------------------
   Markov generator
   ------------------------- */
function generateMarkov(prompt = "", maxTokens = 40) {
  if (!MARKOV || !MARKOV.map || MARKOV.map.size === 0) return "";

  const { order, map } = MARKOV;
  const tokens = (prompt || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  // pick start key
  let key;
  if (tokens.length >= order) {
    key = tokens.slice(tokens.length - order).join("\u0001");
  } else {
    const startKeys = [...map.keys()].filter(k => k.startsWith("^START"));
    key = startKeys.length ? startKeys[Math.floor(Math.random() * startKeys.length)] : [...map.keys()][Math.floor(Math.random() * map.size)];
  }

  const out = [];
  for (let i = 0; i < maxTokens; i++) {
    const choices = map.get(key);
    if (!choices || choices.length === 0) break;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    if (!pick || pick === "^END") break;
    out.push(pick);
    const parts = key.split("\u0001").slice(1);
    parts.push(pick);
    key = parts.join("\u0001");
  }
  return out.join(" ");
}

/* -------------------------
   Utilities: tokenize, keyword scoring
   ------------------------- */
function tokenize(s) {
  return String(s || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
}

function uniqueWords(arr) {
  return [...new Set(arr)];
}

// return number of matched keywords between candidate and sets (intent + global)
function keywordScore(candidate, intentKeywords = [], globalKeywords = []) {
  const candTokens = tokenize(candidate);
  const candSet = new Set(candTokens);
  let score = 0;
  for (const k of intentKeywords) if (k && candSet.has(k.toLowerCase())) score++;
  for (const k of globalKeywords) if (k && candSet.has(k.toLowerCase())) score++;
  return score;
}

/* -------------------------
   Candidate generators (4)
   - markovContinuation(prompt)
   - templateJoiner(intent, prompt, N)
   - examplePlusContinue(intent, prompt)
   - keywordSummary(intent, prompt)
   ------------------------- */

// A - Markov continuation
function markovContinuation(prompt, max=40){
  const out = generateMarkov(prompt, max);
  return out || ""; // may be empty
}

// B - Template joiner: join top keywords into 1-3 short sentences
function templateJoiner(intentName, prompt) {
  const intent = (BRAIN.intents || {})[intentName] || {};
  const intentKeys = (intent.keywords || []).slice(0, 6);
  const globalKeys = Object.values(GLOBAL_KEYWORDS || {}).flat().slice(0, 12);

  const use = [...new Set([...(intentKeys || []), ...(globalKeys || []).slice(0, 6)])].slice(0,6);
  if (use.length === 0) return "";

  // create 2-3 short sentences using keywords
  const parts = [];
  if (use.length >= 1) parts.push(`${capitalize(use[0])} matters most: ${use.slice(1,3).join(", ") || use[0]}.`);
  if (use.length >= 3) parts.push(`Focus on ${use.slice(0,2).join(" & ")} and refine ${use[2]}.`);
  if (use.length >= 4) parts.push(`Small iterations: ${use.slice(3).join(", ")}.`);
  return parts.join(" ");
}

// C - Example + short continuation
function examplePlusContinue(intentName, prompt) {
  const intent = (BRAIN.intents || {})[intentName] || {};
  const ex = (intent.examples || []);
  if (!ex || ex.length === 0) return "";
  const pick = ex[Math.floor(Math.random() * ex.length)];
  const cont = generateMarkov(pick + " " + prompt, 20);
  return (pick + (cont ? ("\n" + cont) : "")).trim();
}

// D - Keyword-focused short summary (concise)
function keywordSummary(intentName, prompt) {
  const intent = (BRAIN.intents || {})[intentName] || {};
  const keys = (intent.keywords || []).slice(0, 6);
  if (!keys || keys.length === 0) return "";
  const joined = keys.map(k => k.toLowerCase()).join(", ");
  return `Key points: ${joined}. Ask me to expand on any of these.`;
}

function capitalize(s){ return String(s||"").charAt(0).toUpperCase() + String(s||"").slice(1); }

/* -------------------------
   Scoring function
   - keyword overlap
   - length penalty (too short) and bonus for mid-length
   - novelty (not identical to prompt)
   ------------------------- */
function scoreCandidate(candidate, prompt, intentName) {
  const intent = (BRAIN.intents || {})[intentName] || {};
  const intentKeys = intent.keywords || [];
  const globalKeysFlat = Object.values(GLOBAL_KEYWORDS || {}).flat();
  const kwScore = keywordScore(candidate, intentKeys, globalKeysFlat);

  // length scoring
  const L = candidate.split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.max(0, Math.min(1, (L - 6) / 20)); // preference for 6-26 words

  // novelty: penalize if candidate repeated from prompt or empty
  const novel = candidate && !candidate.toLowerCase().includes(prompt.trim().toLowerCase());
  const noveltyScore = novel ? 1 : 0;

  // small randomness for diversity
  const rand = Math.random() * 0.2;

  // combine
  return kwScore * 2 + lengthScore * 1.5 + noveltyScore * 1 + rand;
}

/* -------------------------
   Resolve best intent for prompt
   - use triggers + keywords overlap
   ------------------------- */
function detectIntent(prompt) {
  const t = prompt.toLowerCase();
  let best = "fallback";
  let bestScore = -1;

  for (const [iname, intent] of Object.entries(BRAIN.intents || {})) {
    // trigger match quick boost
    let score = 0;
    for (const trig of (intent.triggers || [])) {
      if (!trig) continue;
      if (t.includes(String(trig).toLowerCase())) score += 5;
    }
    // keywords overlap
    for (const k of (intent.keywords || [])) {
      if (!k) continue;
      if (t.includes(String(k).toLowerCase())) score += 2;
    }
    // global keywords overlap
    for (const ks of Object.values(GLOBAL_KEYWORDS || {})) {
      for (const k of ks) if (k && t.includes(k.toLowerCase())) score += 1;
    }

    if (score > bestScore) { bestScore = score; best = iname; }
  }

  return best;
}

/* -------------------------
   Pipeline: create 4 candidates, score & choose
   ------------------------- */
function createAndRankCandidates(prompt, maxTokens=80) {
  const intent = detectIntent(prompt);
  const cands = [];

  // gen A
  const A = markovContinuation(prompt, Math.min(40, maxTokens));
  if (A) cands.push({ label: "markov", text: A });

  // gen B
  const B = templateJoiner(intent, prompt);
  if (B) cands.push({ label: "template", text: B });

  // gen C
  const C = examplePlusContinue(intent, prompt);
  if (C) cands.push({ label: "example+cont", text: C });

  // gen D
  const D = keywordSummary(intent, prompt);
  if (D) cands.push({ label: "summary", text: D });

  // ensure at least 4 entries (fill with short markov variations)
  while (cands.length < 4) {
    const filler = generateMarkov(prompt + " " + (Math.random() > 0.5 ? "more" : ""), 16) || ("Let me think about " + prompt);
    cands.push({ label: "filler", text: filler });
  }

  // score them
  const scored = cands.map((c, i) => {
    return { i, label: c.label, text: c.text, score: scoreCandidate(c.text || "", prompt, intent) };
  });

  scored.sort((a,b)=>b.score - a.score);
  // chosen is top
  const chosen = scored[0];
  // reorder to keep top first in returned list (but include all 4)
  const candidates = scored.slice(0,4).map(s => ({ label: s.label, text: s.text, score: Number(s.score.toFixed(3)) }));
  return { intent, candidates, chosenIndex: 0, chosen: candidates[0]?.text || "" };
}

/* -------------------------
   Routes
   ------------------------- */

loadBrain();
try {
  fs.watchFile(path.join(__dirname, "brain.json"), { interval: 2000 }, () => {
    console.log("brain.json changed — reloading");
    loadBrain();
  });
} catch(_) {}

app.get("/brain", (req,res) => {
  try {
    res.type("application/json").send(fs.readFileSync(path.join(__dirname,"brain.json"),"utf8"));
  } catch(e){
    res.status(500).json({ error: "cannot read brain.json", detail: e.message });
  }
});

app.post("/generate", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const maxTokens = Math.min(120, Number(req.body?.maxTokens || 80));
    const out = createAndRankCandidates(prompt, maxTokens);
    return res.json(out);
  } catch (e) {
    console.error("generate error:", e);
    return res.status(500).json({ error: "generation failed", detail: e.message });
  }
});

// /search keeps homepage link as requested
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });
  try {
    const upstream = `https://cube-search.onrender.com?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream, { headers: { "User-Agent": "CubeAI/1.0" } });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await r.json();
      return res.json(j);
    }
    const html = await r.text();
    const snippet = (html.replace(/\s+/g, " ").slice(0, 1600)).trim();
    return res.json({ results: [{ title: `Search: ${q}`, url: "https://cube-search.onrender.com", text: snippet }] });
  } catch (e) {
    console.error("search proxy error:", e.message);
    return res.status(502).json({ error: "search failed", detail: e.message });
  }
});

app.get("/_health", (_,res)=>res.json({ ok:true, time: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", ()=>console.log(`CubeAI server listening on ${PORT}`));
