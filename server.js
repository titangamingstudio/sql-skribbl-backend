// server.js
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";

// Render gives a dynamic PORT
const PORT = process.env.PORT || 3000;

// Env vars (make sure these are set in Render)
const VALIDATOR_URL = process.env.VALIDATOR_URL; // e.g. https://sql-validator.onrender.com/validate
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIS_URL = process.env.REDIS_URL;

// Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redis = new Redis(REDIS_URL, { tls: {} });

// Create a single HTTP server that serves both WS + /healthz
const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    let status = { ok: true };

    // Test Redis
    try {
      await redis.ping();
      status.redis = "ok";
    } catch {
      status.redis = "fail";
      status.ok = false;
    }

    // Test Supabase
    try {
      const { error } = await supabase.from("submissions").select("id").limit(1);
      status.supabase = error ? "fail" : "ok";
      if (error) status.ok = false;
    } catch {
      status.supabase = "fail";
      status.ok = false;
    }

    res.writeHead(status.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(200);
    res.end("WebSocket + healthz server live");
  }
});

// Attach WebSocket to the same server
const wss = new WebSocketServer({ server });
console.log(`✅ HTTP + WebSocket server starting on :${PORT}`);

wss.on("connection", (ws) => {
  console.log("🌐 Client connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Handle SQL submission
      if (data.type === "submit_sql") {
        const { user_id, round_id, sql, seed_sql } = data;
        console.log("➡️ Received SQL submission:", { user_id, round_id, sql });

        // --- Validator ---
        let verdict;
        try {
          console.log("🔎 Calling validator:", VALIDATOR_URL);
          const res = await fetch(VALIDATOR_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql, seed_sql }),
          });
          verdict = await res.json();
          console.log("✅ Validator response:", verdict);
        } catch (err) {
          console.error("❌ Validator call failed:", err);
          ws.send(JSON.stringify({ type: "error", message: "Validator unavailable" }));
          return;
        }

        // --- Supabase ---
        try {
          const { error } = await supabase.from("submissions").insert([
            {
              round_id: round_id || null,
              user_id: user_id || null,
              sql,
              verdict: verdict.verdict,
            },
          ]);
          if (error) {
            console.error("❌ Supabase insert error:", error);
          } else {
            console.log("✅ Inserted submission into Supabase");
          }
        } catch (err) {
          console.error("❌ Supabase call failed:", err);
        }

        // --- Redis (first correct claim) ---
        if (verdict.verdict === "ok") {
          const claimKey = `round:${round_id || "default"}:winner`;
          try {
            const claimed = await redis.setnx(claimKey, user_id || "anon");
            if (claimed) {
              await redis.expire(claimKey, 60);
              verdict.first_correct = true;
              console.log("🏆 First correct claim set:", claimKey, "by", user_id);
            } else {
              verdict.first_correct = false;
              console.log("⚡ Correct, but not first:", user_id);
            }
          } catch (err) {
            console.error("❌ Redis error:", err);
          }
        }

        // Send verdict back to player
        ws.send(JSON.stringify({ type: "validation_result", ...verdict }));
      }

      // Handle ping
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("❌ Message error:", e);
    }
  });
});

// Start the combined server
server.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});
