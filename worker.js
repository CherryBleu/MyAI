const memoryBuckets = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      const auth = checkAccessToken(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status, request, env);
      const modelInfo = await getModelInfo(env);
      return json(modelInfo, 200, request, env);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const auth = checkAccessToken(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status, request, env);

      const limit = await checkRateLimit(auth.token, env);
      if (!limit.ok) {
        return json(
          { error: `Rate limit exceeded. Retry in ${limit.retryAfterSec}s.` },
          429,
          request,
          env,
          { "Retry-After": String(limit.retryAfterSec) }
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body." }, 400, request, env);
      }

      const { model, messages, temperature } = body ?? {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: "messages is required and must be a non-empty array." }, 400, request, env);
      }
      if (!model || typeof model !== "string") {
        return json({ error: "model is required and must be a string." }, 400, request, env);
      }

      const allowedModels = getAllowedModels(env);
      if (allowedModels.length && !allowedModels.includes(model)) {
        return json({ error: "model is not in allowlist." }, 400, request, env);
      }

      const upstreamApiKey = (env.UPSTREAM_API_KEY || "").trim();
      const baseUrl = (env.UPSTREAM_BASE_URL || "").trim();
      const chatPath = (env.UPSTREAM_CHAT_PATH || "/v1/chat/completions").trim();

      if (!upstreamApiKey || !baseUrl) {
        return json({ error: "Server not configured: missing UPSTREAM_API_KEY or UPSTREAM_BASE_URL." }, 500, request, env);
      }

      const upstreamUrl = `${baseUrl.replace(/\/$/, "")}${chatPath.startsWith("/") ? chatPath : `/${chatPath}`}`;

      const payload = {
        model,
        messages,
        stream: false,
      };

      if (typeof temperature === "number") {
        payload.temperature = temperature;
      }

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
        return json({ error: "Failed to connect upstream model service." }, 502, request, env);
      }

      const text = await upstreamResp.text();
      if (!upstreamResp.ok) {
        return json(
          {
            error: "Upstream request failed.",
            upstreamStatus: upstreamResp.status,
            detail: safeUpstreamError(text),
          },
          502,
          request,
          env
        );
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return json({ error: "Upstream returned non-JSON response." }, 502, request, env);
      }

      const answer = data?.choices?.[0]?.message?.content;
      if (!answer) {
        return json({ error: "No assistant content from upstream." }, 502, request, env);
      }

      return json(
        {
          id: data.id || null,
          model: data.model || model,
          content: answer,
          usage: data.usage || null,
        },
        200,
        request,
        env
      );
    }

    return env.ASSETS.fetch(request);
  },
};

function getAllowedModels(env) {
  const raw = (env.ALLOWED_MODELS || "").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getModelInfo(env) {
  const allowedModels = getAllowedModels(env);
  if (allowedModels.length) {
    return { models: allowedModels, freeInput: false, source: "allowlist" };
  }

  const upstream = await fetchUpstreamModels(env);
  if (upstream.ok) {
    return { models: upstream.models, freeInput: true, source: "upstream" };
  }

  // 无白名单时允许手动输入模型名，避免模型列表接口失败导致前端不可用。
  return {
    models: [],
    freeInput: true,
    source: "manual",
    warning: upstream.error,
  };
}

async function fetchUpstreamModels(env) {
  const upstreamApiKey = (env.UPSTREAM_API_KEY || "").trim();
  const baseUrl = (env.UPSTREAM_BASE_URL || "").trim();
  const path = (env.UPSTREAM_MODELS_PATH || "/v1/models").trim();

  if (!upstreamApiKey || !baseUrl) {
    return { ok: false, error: "missing UPSTREAM_API_KEY or UPSTREAM_BASE_URL" };
  }

  const url = `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
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

function getAccessTokens(env) {
  const raw = (env.ACCESS_TOKENS || "").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function checkAccessToken(request, env) {
  const tokens = getAccessTokens(env);
  if (!tokens.length) {
    return { ok: false, status: 500, error: "Server not configured: ACCESS_TOKENS is empty." };
  }

  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const token = request.headers.get("x-client-token")?.trim() || bearer;

  if (!token) {
    return { ok: false, status: 401, error: "Missing access token." };
  }

  if (!tokens.includes(token)) {
    return { ok: false, status: 403, error: "Invalid access token." };
  }

  return { ok: true, token };
}

async function checkRateLimit(key, env) {
  const perMin = Number(env.RATE_LIMIT_PER_MIN || 0);
  if (!Number.isFinite(perMin) || perMin <= 0) {
    return { ok: true };
  }
  const limit = Math.floor(perMin);

  // 内存限流（简单、零依赖）。Worker 冷启动会重置；若需强一致可接入 KV/DO。
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

function safeUpstreamError(text) {
  if (!text) return "unknown";
  return text.slice(0, 500);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "*";
  const allow = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowedOrigin = !allow.length || allow.includes(origin) ? origin : "null";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Token",
    Vary: "Origin",
  };
}

function json(data, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}
