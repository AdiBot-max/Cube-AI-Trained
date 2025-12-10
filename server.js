/**
 * CubeAI — Turbo V3
 * 4-Response Pipeline + Meaning Keywords + Clean Markov
 * Returns ONLY the final chosen reply
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

app.use(cors({ origin: "*", methods: ["GET","POST"] }));
app.use(express.json());
app.use(express.static("public"));

app.use(rateLimit({
  windowMs: 8000,
  max: 32
}));

let BRAIN = null;
let KEYWORDS = {};
let MARKOV = null;

/* ----------------------------------------
   Load brain.json
---------------------------------------- */
function safeLoadBrain() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    const parsed = JSON.parse(raw);

    BRAIN = parsed.brain || parsed;
    KEYWORDS = BRAIN.keywords || {};
    buildMarkov(BRAIN);

    console.log("Brain loaded. Intents:", Object.keys(BRAIN.intents).length);
  } catch (e) {
    console.log("brain.json load error:", e.message);
    BRAIN = { intents:{} };
  }
}

/* ----------------------------------------
   Markov Builder
---------------------------------------- */
function buildMarkov(brain) {
  const map = new Map();
  const order = 2;

  function feed(text) {
    if (!text) return;
    const w = text.split(/\s+/).filter(Boolean);
    const padded = ["^START", ...w, "^END"];
    for (let i=0; i < padded.length - order; i++) {
      const key = padded.slice(i, i+order).join("\u0001");
      const next = padded[i+order];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(next);
    }
  }

  for (const intent of Object.values(brain.intents)) {
    (intent.examples || []).forEach(feed);
  }

  MARKOV = { order, map };
}

/* ----------------------------------------
   Markov Generate
---------------------------------------- */
function markovGenerate(seed, max=40) {
  if (!MARKOV) return "";
  const {order, map} = MARKOV;

  const words = seed.split(/\s+/).filter(Boolean);
  let key = null;

  if (words.length >= order) {
    key = words.slice(words.length - order).join("\u0001");
  } else {
    const s = [...map.keys()].filter(k => k.startsWith("^START"));
    key = s.length ? s[Math.floor(Math.random()*s.length)] : [...map.keys()][0];
  }

  const out = [];
  for (let i=0; i<max; i++) {
    const arr = map.get(key);
    if (!arr || !arr.length) break;

    const pick = arr[Math.floor(Math.random()*arr.length)];
    if (pick === "^END") break;

    out.push(pick);

    const parts = key.split("\u0001").slice(1);
    parts.push(pick);
    key = parts.join("\u0001");
  }

  return out.join(" ");
}

/* ----------------------------------------
   Semantic "keyword" expansion
---------------------------------------- */
function keywordExpand(prompt, intent) {
  const kw = KEYWORDS[intent] || [];
  if (!kw.length) return prompt;

  // append a few meaning-words to steer generation
  const pick = kw.sort(() => Math.random()-0.5).slice(0, 3).join(" ");
  return prompt + " " + pick;
}

/* ----------------------------------------
   Pipeline #1 — Example + continuation
---------------------------------------- */
function pipe_example(intent, userPrompt) {
  const ex = BRAIN.intents[intent].examples;
  if (!ex || !ex.length) return null;

  const seed = ex[Math.floor(Math.random()*ex.length)];
  const expanded = keywordExpand(seed, intent);

  return {
    label: "example+continuation",
    text: seed + "\n" + markovGenerate(expanded, 45)
  };
}

/* ----------------------------------------
   Pipeline #2 — Pure Markov based on user
---------------------------------------- */
function pipe_markov(userPrompt, intent) {
  const expanded = keywordExpand(userPrompt, intent);
  return {
    label: "markov",
    text: markovGenerate(expanded, 55)
  };
}

/* ----------------------------------------
   Pipeline #3 — Short “thinking summary”
---------------------------------------- */
function pipe_summary(intent) {
  const kw = KEYWORDS[intent] || [];
  if (!kw.length) return null;

  const str = [
    "Let me break it down:",
    kw.slice(0,3).join(", ") + ".",
    markovGenerate(kw.join(" "), 35)
  ].join(" ");

  return {
    label: "summary",
    text: str
  };
}

/* ----------------------------------------
   Pipeline #4 — Template reasoning
---------------------------------------- */
function pipe_template(userPrompt, intent) {
  return {
    label: "template",
    text:
      `Okay, here’s a thought:\n` +
      `• Your message hints at something involving ${KEYWORDS[intent]?.join(", ") || "ideas"}.\n` +
      `• Let me explore it…\n` +
      markovGenerate(userPrompt, 30)
  };
}

/* ----------------------------------------
   Scorer (no more "matters most")
---------------------------------------- */
function scoreCandidate(text, prompt) {
  if (!text) return -999;

  let score = text.length / 10;

  if (text.includes("\n")) score += 1.2;
  if (text.split(" ").length > 12) score += 1.1;

  const p = prompt.toLowerCase();
  const t = text.toLowerCase();

  if (t.includes(p.split(" ")[0])) score += 1;

  // penalty for nonsense
  if (t.length < 6) score -= 4;

  return score;
}

/* ----------------------------------------
   Main generator route
---------------------------------------- */
app.post("/generate", (req, res) => {
  try {
    const prompt = String(req.body.prompt || "").trim();
    const max = Math.min(120, Number(req.body.maxTokens || 60));

    const lower = prompt.toLowerCase();
    let intent = "fallback";

    for (const k in BRAIN.intents) {
      for (const t of BRAIN.intents[k].triggers || []) {
        if (lower.includes(t.toLowerCase())) intent = k;
      }
    }

    // RUN 4 PIPELINES
    const c1 = pipe_example(intent, prompt);
    const c2 = pipe_markov(prompt, intent);
    const c3 = pipe_summary(intent);
    const c4 = pipe_template(prompt, intent);

    const all = [c1, c2, c3, c4].filter(Boolean);

    // PICK BEST
    let best = all[0];
    let bestScore = scoreCandidate(all[0].text, prompt);
    for (const c of all.slice(1)) {
      const sc = scoreCandidate(c.text, prompt);
      if (sc > bestScore) {
        best = c;
        bestScore = sc;
      }
    }

    res.json({
      reply: best.text.trim()
    });

  } catch(e) {
    res.status(500).json({ error:"generation failed", detail:e.message });
  }
});

/* ----------------------------------------
   Search
---------------------------------------- */
app.get("/search", async (req,res)=>{
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error:"Missing q" });

  try {
    const upstream = `https://cube-search.onrender.com?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream);

    const type = r.headers.get("content-type") || "";
    if (type.includes("json")) return res.json(await r.json());

    const text = (await r.text()).replace(/\s+/g," ").slice(0,1500);

    res.json({
      results:[{
        title:`Search results for "${q}"`,
        url:"https://cube-search.onrender.com",
        text
      }]
    });

  } catch (e) {
    res.status(502).json({ error:"Search failed", detail:e.message });
  }
});

/* ----------------------------------------
   Init
---------------------------------------- */
safeLoadBrain();
fs.watchFile(path.join(__dirname, "brain.json"), () => {
  console.log("brain.json changed → reload");
  safeLoadBrain();
});

/* ---------------------------------------- */
app.get("/brain",(req,res)=>{
  res.send(fs.readFileSync(path.join(__dirname,"brain.json"),"utf8"));
});

/* ---------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", ()=>{
  console.log("CubeAI • Turbo V3 • running on", PORT);
});
