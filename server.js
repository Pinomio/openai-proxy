import express from "express";
import OpenAI from "openai";

const app = express();

// ✅ WICHTIG: express.json() (mit Klammern)
app.use(express.json({ limit: "200kb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const WORKFLOW_ID = process.env.OPENAI_WORKFLOW_ID;

// --- Security config ---
const ALLOWED_ORIGINS = new Set([
  "https://gastronex.net",
  "https://www.gastronex.net",
]);

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;

// --- CORS Middleware (nur für deine Domain) ---
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}
app.use(cors);

// --- Preflight (OPTIONS) ---
app.options("*", (req, res) => {
  return res.status(204).send();
});

// --- Simple in-memory rate limit (pro IP) ---
const rl = new Map(); // ip -> { count, resetAt }
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const ip =
      (req.headers["x-forwarded-for"]?.toString().split(",")[0] || "").trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    const entry = rl.get(ip);

    if (!entry || now > entry.resetAt) {
      rl.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: "rate_limited" });
    }
    return next();
  };
}

// --- Turnstile verify (server-side) ---
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return false;

  const resp = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip || "",
      }),
    }
  );

  const data = await resp.json();
  return data?.success === true;
}

app.post(
  "/api/chatkit/session",
  rateLimit({ windowMs: 60_000, max: 10 }), // 10/min/IP
  async (req, res) => {
    try {
      // Origin-Hardcheck (zusätzlich zu CORS)
      const origin = req.headers.origin;
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ error: "origin_not_allowed" });
      }

      const { turnstileToken } = req.body || {};
      if (!turnstileToken) {
        return res.status(400).json({ error: "missing_turnstile_token" });
      }

      const ip =
        (req.headers["x-forwarded-for"]?.toString().split(",")[0] || "").trim() ||
        req.socket.remoteAddress ||
        "";

      const ok = await verifyTurnstile(turnstileToken, ip);
      if (!ok) {
        return res.status(403).json({ error: "bot_check_failed" });
      }

      const session = await openai.chatkit.sessions.create({
        workflow: { id: WORKFLOW_ID },
      });

      return res.json({ client_secret: session.client_secret });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
);

app.get("/", (req, res) => {
  res.send("OpenAI Proxy Running");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("Server running on port", port);
});