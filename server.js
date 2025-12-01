import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

/*
 Get brain.json from Supabase Storage
*/
app.get("/brain", async (req, res) => {
  try {
    const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/brain/brain.json`;

    const response = await fetch(fileUrl, {
      headers: { apikey: SUPABASE_KEY }
    });

    if (!response.ok) {
      return res.status(500).json({ error: "Failed to fetch brain.json" });
    }

    const data = await response.text();

    res.setHeader("Content-Type", "application/json");
    res.send(data);

  } catch (err) {
    res.status(500).json({ error: "Error fetching brain.json" });
  }
});


app.listen(3000, () => {
  console.log("API running on http://localhost:3000");
});
