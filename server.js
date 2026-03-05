import express from "express";

const app = express();
app.use(express.json({ limit: "200kb" }));

// =============================
// ENV VARIABLES
// =============================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;

// =============================
// ALLOWED ORIGINS
// =============================

const ALLOWED_ORIGINS = new Set([
  "https://gastronex.net",
  "https://www.gastronex.net"
]);

// =============================
// SIMPLE CORS
// =============================

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

// =============================
// SESSION STORE
// =============================

const sessions = new Map();

function addSession(secret) {
  sessions.set(secret, Date.now());

  setTimeout(() => {
    sessions.delete(secret);
  }, 1000 * 60 * 30); // 30 Minuten
}

// =============================
// RATE LIMIT
// =============================

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

  if (entry.count > 20) {
    return false;
  }

  entry.count++;
  return true;
}

// =============================
// TURNSTILE VERIFY
// =============================

async function verifyTurnstile(token, ip) {

  const resp = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip || ""
      })
    }
  );

  const data = await resp.json();

  return data.success === true;
}

// =============================
// SESSION ENDPOINT
// =============================

app.post("/api/chatkit/session", async (req, res) => {

  try {

    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown";

    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "rate_limited" });
    }

    const { turnstileToken } = req.body;

    if (!turnstileToken) {
      return res.status(400).json({
        error: "missing_turnstile_token"
      });
    }

    const ok = await verifyTurnstile(turnstileToken, ip);

    if (!ok) {
      return res.status(403).json({
        error: "bot_check_failed"
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_MODEL
        })
      }
    );

    const data = await response.json();

    const client_secret =
      data.client_secret?.value ??
      data.client_secret;

    addSession(client_secret);

    res.json({
      client_secret
    });

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});

// =============================
// MESSAGE ENDPOINT
// =============================

app.post("/api/chatkit/message", async (req, res) => {

  try {

    const { client_secret, messages, system_prompt } = req.body;

    if (!client_secret || !sessions.has(client_secret)) {
      return res.status(403).json({
        error: "invalid_session"
      });
    }

    if (!messages) {
      return res.status(400).json({
        error: "missing_parameters"
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            ...(system_prompt
              ? [{ role: "system", content: system_prompt }]
              : []),
            ...messages
          ]
        })
      }
    );

    const data = await response.json();

    res.json(data);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});

// =============================
// HEALTH CHECK
// =============================

app.get("/", (req, res) => {
  res.send("OpenAI Proxy Running");
});

// =============================
// START SERVER
// =============================

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log("Server running on port", port);
});