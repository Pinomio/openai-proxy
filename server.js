import express from "express";
import OpenAI from "openai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "200kb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;

// Für Produktion besser als Env Var:
// const OPENAI_WORKFLOW_ID = process.env.OPENAI_WORKFLOW_ID;
const OPENAI_WORKFLOW_ID =
  "wf_69a4fdb398488190b1b2c794f4729e71080dd663d949b0e4";

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const ALLOWED_ORIGINS = new Set([
  "https://gastronex.net",
  "https://www.gastronex.net",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send();
  }

  next();
});

const rateLimit = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);

  if (!entry) {
    rateLimit.set(ip, { count: 1, reset: now + 60000 });
    return true;
  }

  if (now > entry.reset) {
    rateLimit.set(ip, { count: 1, reset: now + 60000 });
    return true;
  }

  if (entry.count >= 20) {
    return false;
  }

  entry.count++;
  return true;
}

async function verifyTurnstile(token, ip) {
  const resp = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip || "",
      }),
    }
  );

  const data = await resp.json();
  return data.success === true;
}

app.post("/api/chatkit/session", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "rate_limited" });
    }

    const { turnstileToken, userId } = req.body;

    if (!turnstileToken) {
      return res.status(400).json({ error: "missing_turnstile_token" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_openai_api_key" });
    }

    if (!TURNSTILE_SECRET) {
      return res.status(500).json({ error: "missing_turnstile_secret" });
    }

    if (!OPENAI_WORKFLOW_ID) {
      return res.status(500).json({ error: "missing_workflow_id" });
    }

    const ok = await verifyTurnstile(turnstileToken, ip);
    if (!ok) {
      return res.status(403).json({ error: "bot_check_failed" });
    }

    const safeUserId =
      typeof userId === "string" && userId.trim()
        ? userId.trim()
        : `anon_${crypto.randomUUID()}`;

    const session = await client.chatkit.sessions.create({
      workflow: {
        id: OPENAI_WORKFLOW_ID,
      },
      user: safeUserId,
    });

    return res.json({
      client_secret: session.client_secret,
    });
  } catch (error) {
    console.error("chatkit session error:", error);
    return res.status(500).json({
      error: "session_create_failed",
      details: error?.message || "unknown_error",
    });
  }
});

app.get("/", (req, res) => {
  res.send("ChatKit Proxy Running");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("Server running on port", port);
});