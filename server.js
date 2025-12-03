import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import fs from "fs";
import * as cheerio from "cheerio"; // FIXED IMPORT


const app = express();

app.set("trust proxy", 1);
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static("public"));

const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30
});
app.use(limiter);

// Serve brain.json locally
app.get("/brain", (req, res) => {
  try {
    const raw = fs.readFileSync("./brain.json", "utf8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: "Cannot load brain.json" });
  }
});

// Proxy search to cube-search
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  try {
    const api = `https://cube-search.onrender.com/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(api);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// Extract webpage main text for answers
app.get("/extract", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const html = await (await fetch(url)).text();
    const $ = cheerio.load(html);

    let answer =
      $('meta[name="description"]').attr("content") ||
      $("p").first().text().trim() ||
      $("body").text().slice(0, 500);

    answer = answer.replace(/\s+/g, " ").trim();

    res.json({
      answer: answer.slice(0, 400),
      title: $("title").text().trim()
    });

  } catch (err) {
    res.json({ answer: null, title: null });
  }
});

app.get("/_health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://0.0.0.0:${PORT}`));

