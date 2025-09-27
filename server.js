// server.js
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";

// -----------------------
// ENV VARS
// -----------------------
const PORT = process.env.PORT || 3000;
const VALIDATOR_URL = process.env.VALIDATOR_URL; // e.g. https://sql-validator.onrender.com/validate
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIS_URL = process.env.REDIS_URL;

// -----------------------
// CLIENTS
// -----------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Upstash Redis with TLS
const redis = new Redis(REDIS_URL, { tls: {} });

// Log Redis connection status
redis.on("connect", () => console.log("[Redis] Connected"));
redis.on("error", (err) => console.error("[Redis] Error:", err.message));

// -----------------------
// WEBSOCKET SERVER
// -----------------------
const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket server listening on :${PORT}`);

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log("[WS] Received:", data);

      if (data.type === "submit_sql") {
        const { user_id = "debug-user", round_id = "debug-round", sql, seed_sql } = data;

        // -----------------------
        // 1. Call validator
        // -----------------------
        console.log("[Validator] Sending SQL:", sql);
        const res = await fetch(VALIDATOR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql, seed_sql }),
        });
        const verdict = await res.json();
        console.log("[Validator] Response:", verdict);

        // -----------------------
        // 2. Save to Supabase
        // -----------------------
        const { error } = await supabase.from("submissions").insert([
          { round_id, user_id, sql, verdict: verdict.verdict },
        ]);
        if (error) {
          console.error("[Supabase] Insert error:", error.message);
        } else {
          console.log("[Supabase] Insert success");
        }

        // -----------------------
        // 3. Redis first-correct claim
        // -----------------------
        if (verdict.verdict === "ok") {
          const claimKey = `round:${round_id}:winner`;
          const claimed = await redis.setnx(claimKey, user_id);
          if (claimed) {
            await redis.expire(claimKey, 60);
            verdict.first_correct = true;
            console.log(`[Redis] Winner claimed for ${round_id} by ${user_id}`);
          } else {
            verdict.first_correct = false;
            console.log(`[Redis] Already claimed for ${round_id}`);
          }
        }

        // -----------------------
        // 4. Broadcast verdict
        // -----------------------
        broadcast({ type: "validation_result", ...verdict });
      }

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("[WS] Message error:", e.message);
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
