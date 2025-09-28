// server.js (complete)
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import Redis from "ioredis";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const VALIDATOR_URL = process.env.VALIDATOR_URL; // e.g. https://sql-validator.../validate
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REDIS_URL = process.env.REDIS_URL;

if (!VALIDATOR_URL || !SUPABASE_URL || !SUPABASE_KEY || !REDIS_URL) {
  console.error("Missing required env vars (VALIDATOR_URL, SUPABASE_URL, SUPABASE_KEY, REDIS_URL)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redis = new Redis(REDIS_URL, { tls: {} });

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    // simple health response; more detailed checks could be added
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SQL Skribbl WebSocket (ws) server");
  }
});

const wss = new WebSocketServer({ server });

console.log("WebSocket server starting on port", PORT);

// Buffer for batch insert
let submissionBuffer = [];
const FLUSH_INTERVAL_MS = 5000; // flush every 5s
const MAX_BATCH_SIZE = 50;

setInterval(async () => {
  if (submissionBuffer.length === 0) return;
  const bufferToFlush = submissionBuffer.splice(0, submissionBuffer.length);
  try {
    const { error } = await supabase
      .from("submissions")
      .insert(bufferToFlush);
    if (error) console.error("Batch insert error:", error);
    else console.log(`Flushed ${bufferToFlush.length} submissions to Supabase`);
  } catch (err) {
    console.error("Supabase batch insert exception:", err);
  }
}, FLUSH_INTERVAL_MS);

// helper: get random question by difficulty
async function fetchRandomQuestion(difficulty) {
  // Adjust column names if your questions table uses different names
  const { data, error } = await supabase
    .from("questions")
    .select("*")
    .eq("difficulty", difficulty)
    .limit(100); // fetch up to 100 candidates to randomize over
  if (error) {
    console.error("Supabase fetchRandomQuestion error:", error);
    return null;
  }
  if (!data || data.length === 0) return null;
  // pick one random
  const idx = Math.floor(Math.random() * data.length);
  return data[idx];
}

wss.on("connection", (ws, req) => {
  console.log("🌐 Client connected", req.socket.remoteAddress);

  // You might want to add basic per-socket state
  ws.state = {
    user_id: null,
    room_id: null,
  };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Client asks to join singleplayer with difficulty
      if (msg.type === "join_single") {
        // expected fields: username, difficulty
        const username = msg.username || "anon";
        const difficulty = msg.difficulty || "beginner";

        // create or get user in Supabase
        let userId = msg.user_id || null;
        if (!userId) {
          // upsert user by username (simple)
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

        // fetch question
        const question = await fetchRandomQuestion(difficulty);
        if (!question) {
          ws.send(JSON.stringify({ type: "error", message: "No questions available" }));
          return;
        }

        // create a new game and round entry in Supabase (optional)
        const { data: gdata, error: gerr } = await supabase
          .from("games")
          .insert({})
          .select("id")
          .limit(1)
          .single()
          .catch(() => ({ data: null, error: "game create failed" }));
        const game_id = gdata ? gdata.id : null;

        const { data: rdata, error: rerr } = await supabase
          .from("rounds")
          .insert({ game_id, question_id: question.id })
          .select("id")
          .limit(1)
          .single()
          .catch(() => ({ data: null }));

        const round_id = rdata ? rdata.id : null;
        ws.state.round_id = round_id;

        // send question to client
        ws.send(JSON.stringify({
          type: "question",
          question_id: question.id,
          prompt: question.prompt,
          difficulty: question.difficulty,
          topic: question.topic,
          // don't need to send seed_sql to client unless you want preview_rows.
          // still include it server-side when validating:
          preview_rows: null
        }));

        console.log("Sent question", question.id, "to user", userId);
        return;
      }

      // Client submits SQL
      if (msg.type === "submit_sql") {
        const { sql, question_id } = msg;
        const user_id = ws.state.user_id || msg.user_id || null;
        const round_id = ws.state.round_id || msg.round_id || null;

        // Fetch question row from supabase (to get seed_sql, expected_sql, checker_type)
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

        // Call validator with seed, expected, player's SQL
        const payload = {
          sql: sql,
          seed_sql: question.seed_sql,
          expected_sql: question.expected_sql,
          checker_type: question.checker_type || 'exact_set'
        };

        console.log("➡️ Received SQL submission:", { user_id, round_id, sql, question_id });

        let verdictObj;
        try {
          const res = await fetch(VALIDATOR_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: 5000
          });
          verdictObj = await res.json();
          console.log("✅ Validator response:", verdictObj);
        } catch (err) {
          console.error("Validator call failed", err);
          ws.send(JSON.stringify({ type: "error", message: "Validator unreachable" }));
          return;
        }

        // Add to submission buffer (store verdict string)
        const submissionRow = {
          round_id,
          user_id,
          sql,
          verdict: verdictObj.verdict || (verdictObj.valid ? 'ok' : 'wrong'),
          created_at: new Date().toISOString()
        };

        submissionBuffer.push(submissionRow);
        if (submissionBuffer.length >= MAX_BATCH_SIZE) {
          // trigger immediate flush next interval; optional: call flush function
        }

        // If correct, try first-claim via Redis
        if (verdictObj.verdict === "ok" || verdictObj.valid === true) {
          const claimKey = `round:${round_id}:winner`;
          try {
            const claimed = await redis.setnx(claimKey, user_id || "anon");
            if (claimed) {
              await redis.expire(claimKey, 60);
              // award points here (in-memory or persist)
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

        // echo verdict back to client
        ws.send(JSON.stringify({ type: "validation_result", question_id, ...verdictObj }));

        return;
      }

      // ping/pong
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // unknown message
      ws.send(JSON.stringify({ type: "error", message: "unknown message type" }));

    } catch (err) {
      console.error("Message handler error:", err);
      ws.send(JSON.stringify({ type: "error", message: "server error" }));
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
