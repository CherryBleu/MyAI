const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

loadDotEnvLikeFile(path.join(process.cwd(), ".dev.vars"));

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const memoryBuckets = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);

  if (method === "OPTIONS") {
    writeCors(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/models" && method === "GET") {
    const auth = checkAccessToken(req);
    if (!auth.ok) return sendJson(res, req, auth.status, { error: auth.error });

    const modelInfo = await getModelInfo();
    return sendJson(res, req, 200, modelInfo);
  }

  if (url.pathname === "/api/chat" && method === "POST") {
    const auth = checkAccessToken(req);
    if (!auth.ok) return sendJson(res, req, auth.status, { error: auth.error });

    const limit = checkRateLimit(auth.token);
    if (!limit.ok) {
      return sendJson(
        res,
        req,
        429,
        { error: `Rate limit exceeded. Retry in ${limit.retryAfterSec}s.` },
        { "Retry-After": String(limit.retryAfterSec) }
      );
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, req, 400, { error: err.message || "Invalid JSON body." });
    }

    const { model, messages, temperature } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, req, 400, { error: "messages is required and must be a non-empty array." });
    }
    if (!model || typeof model !== "string") {
      return sendJson(res, req, 400, { error: "model is required and must be a string." });
    }

    const allowedModels = getAllowedModels();
    if (allowedModels.length && !allowedModels.includes(model)) {
      return sendJson(res, req, 400, { error: "model is not in allowlist." });
    }

    const upstreamApiKey = (process.env.UPSTREAM_API_KEY || "").trim();
    const baseUrl = (process.env.UPSTREAM_BASE_URL || "").trim();
    const chatPath = (process.env.UPSTREAM_CHAT_PATH || "/v1/chat/completions").trim();

    if (!upstreamApiKey || !baseUrl) {
      return sendJson(res, req, 500, { error: "Server not configured: missing UPSTREAM_API_KEY or UPSTREAM_BASE_URL." });
    }

    const upstreamUrl = `${baseUrl.replace(/\/$/, "")}${chatPath.startsWith("/") ? chatPath : `/${chatPath}`}`;

    const payload = {
      model,
      messages,
      stream: false,
    };
    if (typeof temperature === "number") payload.temperature = temperature;

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${upstreamApiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      return sendJson(res, req, 502, { error: "Failed to connect upstream model service." });
    }

    const text = await upstreamResp.text();
    if (!upstreamResp.ok) {
      return sendJson(res, req, 502, {
        error: "Upstream request failed.",
        upstreamStatus: upstreamResp.status,
        detail: safeUpstreamError(text),
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return sendJson(res, req, 502, { error: "Upstream returned non-JSON response." });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) {
      return sendJson(res, req, 502, { error: "No assistant content from upstream." });
    }

    return sendJson(res, req, 200, {
      id: data.id || null,
      model: data.model || model,
      content: answer,
      usage: data.usage || null,
    });
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MyAI Node server ready on http://0.0.0.0:${PORT}`);
});

function writeCors(res, req) {
  const origin = req.headers.origin || "*";
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigin = !allow.length || allow.includes(origin) ? origin : "null";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client-Token");
  res.setHeader("Vary", "Origin");
}

function sendJson(res, req, status, data, extraHeaders = {}) {
  writeCors(res, req);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function getAllowedModels() {
  return (process.env.ALLOWED_MODELS || "")
    .trim()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAccessTokens() {
  return (process.env.ACCESS_TOKENS || "")
    .trim()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkAccessToken(req) {
  const tokens = getAccessTokens();
  if (!tokens.length) {
    return { ok: false, status: 500, error: "Server not configured: ACCESS_TOKENS is empty." };
  }

  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const token = (req.headers["x-client-token"] || "").toString().trim() || bearer;

  if (!token) {
    return { ok: false, status: 401, error: "Missing access token." };
  }
  if (!tokens.includes(token)) {
    return { ok: false, status: 403, error: "Invalid access token." };
  }

  return { ok: true, token };
}

function checkRateLimit(key) {
  const perMin = Number(process.env.RATE_LIMIT_PER_MIN || 0);
  if (!Number.isFinite(perMin) || perMin <= 0) {
    return { ok: true };
  }

  const limit = Math.floor(perMin);
  const now = Date.now();
  const bucket = memoryBuckets.get(key) || { count: 0, resetAt: now + 60_000 };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }

  bucket.count += 1;
  memoryBuckets.set(key, bucket);

  if (bucket.count > limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  return { ok: true };
}

async function getModelInfo() {
  const allowedModels = getAllowedModels();
  if (allowedModels.length) {
    return { models: allowedModels, freeInput: false, source: "allowlist" };
  }

  const upstream = await fetchUpstreamModels();
  if (upstream.ok) {
    return { models: upstream.models, freeInput: true, source: "upstream" };
  }

  return {
    models: [],
    freeInput: true,
    source: "manual",
    warning: upstream.error,
  };
}

async function fetchUpstreamModels() {
  const upstreamApiKey = (process.env.UPSTREAM_API_KEY || "").trim();
  const baseUrl = (process.env.UPSTREAM_BASE_URL || "").trim();
  const pathPart = (process.env.UPSTREAM_MODELS_PATH || "/v1/models").trim();

  if (!upstreamApiKey || !baseUrl) {
    return { ok: false, error: "missing UPSTREAM_API_KEY or UPSTREAM_BASE_URL" };
  }

  const url = `${baseUrl.replace(/\/$/, "")}${pathPart.startsWith("/") ? pathPart : `/${pathPart}`}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${upstreamApiKey}` },
    });
  } catch {
    return { ok: false, error: "failed to fetch upstream models" };
  }

  if (!resp.ok) {
    return { ok: false, error: `upstream models failed: ${resp.status}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, error: "upstream models response is not valid JSON" };
  }

  const models = Array.isArray(data?.data)
    ? data.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
    : [];

  return { ok: true, models: [...new Set(models)].sort() };
}

function safeUpstreamError(text) {
  if (!text) return "unknown";
  return text.slice(0, 500);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", () => reject(new Error("Failed to read request body.")));
  });
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${cleanPath}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (pathname !== "/" && pathname !== "/index.html") {
        // SPA-style fallback: unknown path goes to index.
        return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(indexData);
        });
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function loadDotEnvLikeFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();

    if (!key) continue;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
