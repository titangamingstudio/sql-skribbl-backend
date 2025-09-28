// server.js
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import Redis from "ioredis";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const VALIDATOR_URL = process.env.VALIDATOR_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIS_URL = process.env.REDIS_URL;

if (!VALIDATOR_URL || !SUPABASE_URL || !SUPABASE_KEY || !REDIS_URL) {
  console.error("❌ Missing required env vars (VALIDATOR_URL, SUPABASE_URL, SUPABASE_KEY, REDIS_URL)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redis = new Redis(REDIS_URL, { tls: {} });

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SQL Skribbl WebSocket (ws) server");
  }
});

const wss = new WebSocketServer({ server });
console.log("🚀 WebSocket server starting on port", PORT);

// Buffer for submissions
let submissionBuffer = [];
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 50;

setInterval(async () => {
  if (submissionBuffer.length === 0) return;
  const bufferToFlush = submissionBuffer.splice(0, submissionBuffer.length);
  try {
    const { error } = await supabase.from("submissions").insert(bufferToFlush);
    if (error) console.error("Batch insert error:", error);
    else console.log(`✅ Flushed ${bufferToFlush.length} submissions to Supabase`);
  } catch (err) {
    console.error("Supabase batch insert exception:", err);
  }
}, FLUSH_INTERVAL_MS);

// helper: pick random question
async function fetchRandomQuestion(difficulty) {
  const { data, error } = await supabase
    .from("questions")
    .select("*")
    .eq("difficulty", difficulty)
    .limit(100);

  if (error) {
    console.error("Supabase fetchRandomQuestion error:", error);
    return null;
  }
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx];
}

wss.on("connection", (ws, req) => {
  console.log("🌐 Client connected", req.socket.remoteAddress);

  ws.state = { user_id: null, room_id: null, round_id: null };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // --- join_single ---
      if (msg.type === "join_single") {
        const username = msg.username || "anon";
        const difficulty = msg.difficulty || "beginner";
        const round_time = msg.round_time || 30; // 🔹 host decides, default 30

        // ensure user exists
        let userId = msg.user_id || null;
        if (!userId) {
          const { data: existingUser, error: qerr } = await supabase
            .from("users")
            .select("id")
            .eq("username", username)
            .limit(1);

          if (qerr) console.error("User lookup error:", qerr);
          if (existingUser && existingUser.length > 0) {
            userId = existingUser[0].id;
          } else {
            const { data: created, error: ierr } = await supabase
              .from("users")
              .insert({ username })
              .select("id")
              .single();
            if (ierr) console.error("User create error:", ierr);
            else userId = created.id;
          }
        }
        ws.state.user_id = userId;

        // fetch random question
        const question = await fetchRandomQuestion(difficulty);
        if (!question) {
          ws.send(JSON.stringify({ type: "error", message: "No questions available" }));
          return;
        }

        // create game + round
        const { data: gdata } = await supabase
          .from("games")
          .insert({})
          .select("id")
          .single()
          .catch(() => ({ data: null }));
        const game_id = gdata ? gdata.id : null;

        const { data: rdata } = await supabase
          .from("rounds")
          .insert({ game_id, question_id: question.id })
          .select("id")
          .single()
          .catch(() => ({ data: null }));
        const round_id = rdata ? rdata.id : null;
        ws.state.round_id = round_id;

        // send question with round_time
        ws.send(JSON.stringify({
          type: "question",
          question_id: question.id,
          prompt: question.prompt,
          difficulty: question.difficulty,
          topic: question.topic,
          round_time: round_time
        }));

        console.log(`➡️ Sent question ${question.id} (round_time=${round_time}s) to ${username}`);
        return;
      }

      // --- submit_sql ---
      if (msg.type === "submit_sql") {
        const { sql, question_id } = msg;
        const user_id = ws.state.user_id || msg.user_id || null;
        const round_id = ws.state.round_id || msg.round_id || null;

        const { data: qrows, error: qerr } = await supabase
          .from("questions")
          .select("*")
          .eq("id", question_id)
          .limit(1);

        if (qerr || !qrows || qrows.length === 0) {
          ws.send(JSON.stringify({ type: "error", message: "Question not found" }));
          return;
        }
        const question = qrows[0];

        // call validator
        const payload = {
          sql,
          seed_sql: question.seed_sql,
          expected_sql: question.expected_sql,
          checker_type: question.checker_type || "exact_set"
        };

        let verdictObj;
        try {
          const res = await fetch(VALIDATOR_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: 5000
          });
          verdictObj = await res.json();
        } catch (err) {
          console.error("Validator call failed", err);
          ws.send(JSON.stringify({ type: "error", message: "Validator unreachable" }));
          return;
        }

        // push submission into buffer
        const submissionRow = {
          round_id,
          user_id,
          sql,
          verdict: verdictObj.verdict || (verdictObj.valid ? "ok" : "wrong"),
          created_at: new Date().toISOString()
        };
        submissionBuffer.push(submissionRow);

        // check first-correct
        if (verdictObj.verdict === "ok" || verdictObj.valid === true) {
          const claimKey = `round:${round_id}:winner`;
          try {
            const claimed = await redis.setnx(claimKey, user_id || "anon");
            if (claimed) {
              await redis.expire(claimKey, 60);
              verdictObj.first_correct = true;
              console.log("🏆 First correct for round", round_id, "by user", user_id);
            } else {
              verdictObj.first_correct = false;
              console.log("✅ Correct but not first:", user_id);
            }
          } catch (err) {
            console.error("Redis SETNX error", err);
          }
        }

        ws.send(JSON.stringify({ type: "validation_result", question_id, ...verdictObj }));
        return;
      }

      // --- ping ---
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // fallback
      ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (err) {
      console.error("Message handler error:", err);
      ws.send(JSON.stringify({ type: "error", message: "server error" }));
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log("✅ Server listening on port", PORT);
});
