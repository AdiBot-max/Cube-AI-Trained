/**
 * CubeAI — Full Generative Server
 * No fixed responses. Only examples + Markov.
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

// Limit spam
app.use(rateLimit({
  windowMs: 10_000,
  max: 30
}));

let BRAIN = null;
let MARKOV = null;

/* ----------------------------------------
   Load brain.json
---------------------------------------- */
function safeLoadBrain() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "brain.json"), "utf8");
    const parsed = JSON.parse(raw);
    BRAIN = parsed.brain || parsed;

    buildMarkov(BRAIN);

    console.log("Brain loaded. Intents:", Object.keys(BRAIN.intents).length);
  } catch(e) {
    console.log("brain.json load error:", e.message);
    BRAIN = { intents:{} };
    MARKOV = {order:2, map:new Map()};
  }
}

/* ----------------------------------------
   Build Markov Generator
---------------------------------------- */
function buildMarkov(brain) {
  const order = 2;
  const map = new Map();

  function feed(str) {
    if (!str || typeof str !== "string") return;
    const words = str.split(/\s+/).filter(Boolean);
    if (!words.length) return;

    const padded = ["^START", ...words, "^END"];
    for (let i=0; i < padded.length - order; i++) {
      const key = padded.slice(i, i+order).join("\u0001");
      const next = padded[i+order];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(next);
    }
  }

  // Use only examples
  for (const intent of Object.values(brain.intents)) {
    (intent.examples || []).forEach(ex => feed(ex));
  }

  MARKOV = {order, map};
}

/* ----------------------------------------
   Generate text
---------------------------------------- */
function generate(prompt, max=40) {
  if (!MARKOV || !MARKOV.map || MARKOV.map.size === 0)
    return "I don't know yet.";

  const {order, map} = MARKOV;
  const tokens = prompt.split(/\s+/).filter(Boolean);

  let key;
  if (tokens.length >= order) {
    key = tokens.slice(tokens.length - order).join("\u0001");
  } else {
    const startKeys = [...map.keys()].filter(k => k.startsWith("^START"));
    key = startKeys.length
      ? startKeys[Math.floor(Math.random()*startKeys.length)]
      : [...map.keys()][0];
  }

  const out = [];
  for (let i=0;i<max;i++) {
    const choices = map.get(key);
    if (!choices || !choices.length) break;

    const pick = choices[Math.floor(Math.random()*choices.length)];
    if (pick === "^END") break;

    out.push(pick);

    const parts = key.split("\u0001").slice(1);
    parts.push(pick);
    key = parts.join("\u0001");
  }

  return out.join(" ");
}

/* ----------------------------------------
   Watch Brain
---------------------------------------- */
safeLoadBrain();
fs.watchFile(path.join(__dirname, "brain.json"), () => {
  console.log("brain.json updated → reloading");
  safeLoadBrain();
});

/* ----------------------------------------
   Routes
---------------------------------------- */
app.get("/brain", (req,res)=>{
  res.send(fs.readFileSync(path.join(__dirname,"brain.json"),"utf8"));
});

app.post("/generate", (req,res)=>{
  try {
    const prompt = String(req.body.prompt || "");
    const max = Math.min(120, Number(req.body.maxTokens||60));
    const text = generate(prompt, max);
    res.json({ reply:text });
  } catch(e) {
    res.status(500).json({ error:"generation failed", detail:e.message });
  }
});

app.get("/search", async (req,res)=>{
  const q = String(req.query.q||"").trim();
  if (!q) return res.status(400).json({ error:"Missing q" });

  try {
    const upstream = `https://cube-search.onrender.com?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream);
    const type = r.headers.get("content-type") || "";
    if (type.includes("json")) return res.json(await r.json());

    const html = await r.text();
    const snippet = html.replace(/\s+/g," ").slice(0,1500);

    res.json({
      results:[{
        title:`Search result for "${q}"`,
        url:"https://cube-search.onrender.com",
        text:snippet
      }]
    });

  } catch(e) {
    res.status(502).json({ error:"Search failed", detail:e.message });
  }
});

app.get("/_health",(req,res)=>res.json({ok:true}));

/* ----------------------------------------
   Start server
---------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", ()=>console.log("CubeAI server at", PORT));
