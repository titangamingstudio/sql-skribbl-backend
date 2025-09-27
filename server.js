// server.js
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";
import "dotenv/config";


const PORT = process.env.PORT || 3000;

// Env vars
const VALIDATOR_URL = process.env.VALIDATOR_URL; // e.g. https://validator.onrender.com/validate
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIS_URL = process.env.REDIS_URL;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const redis = new Redis(process.env.REDIS_URL, {
  tls: {}   // tells ioredis to use TLS
});


const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server listening on :${PORT}`);

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Player submits SQL
      if (data.type === "submit_sql") {
        const { user_id, round_id, sql, seed_sql } = data;

        // Validate via FastAPI
        const res = await fetch(VALIDATOR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql, seed_sql }),
        });
        const verdict = await res.json();

        // Save submission to DB
        await supabase.from("submissions").insert([
          {
            round_id,
            user_id,
            sql,
            verdict: verdict.verdict,
          },
        ]);

        // First correct claim via Redis
        if (verdict.verdict === "ok") {
          const claimKey = `round:${round_id}:winner`;
          const claimed = await redis.setnx(claimKey, user_id);
          if (claimed) {
            await redis.expire(claimKey, 60); // expire after 1 min
            verdict.first_correct = true;
          } else {
            verdict.first_correct = false;
          }
        }

        // Broadcast result to all clients
        broadcast({ type: "validation_result", ...verdict });
      }

      // Handle ping
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("Message error", e);
    }
  });
});

// Helper: broadcast to all connected clients
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
