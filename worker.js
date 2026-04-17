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

      const provider = resolveProvider(url.searchParams.get("provider"), env);
      const modelInfo = await getModelInfo(provider, env);
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

      const provider = resolveProvider(body?.provider, env);
      const forwarded = await forwardChatByProvider({ provider, body, model, messages, temperature, env });
      if (!forwarded.ok) {
        return json(
          {
            error: forwarded.error || "Upstream request failed.",
            upstreamStatus: forwarded.upstreamStatus || null,
            detail: forwarded.detail || undefined,
            provider,
          },
          502,
          request,
          env
        );
      }

      return json(
        {
          id: forwarded.id || null,
          provider,
          model: forwarded.model || model,
          content: forwarded.assistant.text || "(鏃犳枃鏈洖澶嶏紝璇锋煡鐪?message 瀛楁)",
          message: forwarded.assistant.message,
          usage: forwarded.usage || null,
        },
        200,
        request,
        env
      );
    }

    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
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

      const provider = resolveProvider(body?.provider, env);
      return streamChatResponse(request, env, { provider, body, model, messages, temperature });
    }

    return env.ASSETS.fetch(request);
  },
};

function resolveProvider(input, env) {
  return normalizeProvider(input, getDefaultProvider(env));
}

function getDefaultProvider(env) {
  return normalizeProvider(env.UPSTREAM_PROVIDER || "openai_compatible", "openai_compatible");
}

function normalizeProvider(input, fallback = "openai_compatible") {
  const base = String(fallback || "openai_compatible").trim().toLowerCase();
  const p = String(input || "").trim().toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "gemini" || p === "google" || p === "google_gemini") return "gemini";
  if (p === "openai" || p === "openai_compatible" || p === "openai-compatible") return "openai_compatible";
  return base === "anthropic" || base === "gemini" ? base : "openai_compatible";
}

function getAllowedModels(env) {
  const raw = (env.ALLOWED_MODELS || "").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sseHeaders(request, env, extraHeaders = {}) {
  return {
    ...corsHeaders(request, env),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    ...extraHeaders,
  };
}

function encodeSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamChatResponse(request, env, { provider, body, model, messages, temperature }) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      try {
        const streamed = await streamChatByProvider({
          provider,
          body,
          model,
          messages,
          temperature,
          signal: request.signal,
          async onDelta(delta) {
            if (!delta) return;
            send("delta", { delta });
          },
        });

        if (streamed.ok) {
          send("done", {
            id: streamed.id || null,
            provider,
            model: streamed.model || model,
            text: streamed.text || "",
            usage: streamed.usage || null,
          });
        } else if (!request.signal.aborted) {
          send("error", {
            error: streamed.error || "Upstream request failed.",
            upstreamStatus: streamed.upstreamStatus || null,
            detail: streamed.detail || undefined,
          });
        }
      } catch (err) {
        if (!request.signal.aborted) {
          send("error", { error: err?.message || "stream failed" });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(request, env),
  });
}

async function getModelInfo(provider, env) {
  const allowedModels = getAllowedModels(env);
  if (allowedModels.length) {
    return { provider, models: allowedModels, freeInput: false, source: "allowlist" };
  }

  const upstream = await fetchModelsByProvider(provider, env);
  if (upstream.ok) {
    return { provider, models: upstream.models, freeInput: true, source: "upstream" };
  }

  return {
    provider,
    models: [],
    freeInput: true,
    source: "manual",
    warning: upstream.error,
  };
}

async function fetchModelsByProvider(provider, env) {
  if (provider === "anthropic") return fetchAnthropicModels(env);
  if (provider === "gemini") return fetchGeminiModels(env);
  return fetchOpenAICompatibleModels(env);
}

async function fetchOpenAICompatibleModels(env) {
  const cfg = getOpenAICompatibleConfig(env);
  if (!cfg.ok) return cfg;

  const url = buildUrl(cfg.baseUrl, cfg.modelsPath);
  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: buildOpenAICompatibleAuthHeaders(cfg),
    });
  } catch {
    return { ok: false, error: "failed to fetch upstream models" };
  }

  const parsed = await readUpstreamJson(resp);
  if (!parsed.ok) return parsed;

  const data = parsed.data || {};
  const models = Array.isArray(data?.data)
    ? data.data
        .map((item) => item?.id)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
    : [];

  return { ok: true, models: uniqueSorted(models) };
}

async function fetchAnthropicModels(env) {
  const cfg = getAnthropicConfig(env);
  if (!cfg.ok) return cfg;

  const url = buildUrl(cfg.baseUrl, cfg.modelsPath);
  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": cfg.version,
      },
    });
  } catch {
    return { ok: false, error: "failed to fetch anthropic models" };
  }

  const parsed = await readUpstreamJson(resp);
  if (!parsed.ok) return parsed;

  const data = parsed.data || {};
  const models = Array.isArray(data?.data)
    ? data.data
        .map((item) => item?.id || item?.name)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
    : [];

  return { ok: true, models: uniqueSorted(models) };
}

async function fetchGeminiModels(env) {
  const cfg = getGeminiConfig(env);
  if (!cfg.ok) return cfg;

  const url = buildUrl(cfg.baseUrl, cfg.modelsPath);
  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "x-goog-api-key": cfg.apiKey,
      },
    });
  } catch {
    return { ok: false, error: "failed to fetch gemini models" };
  }

  const parsed = await readUpstreamJson(resp);
  if (!parsed.ok) return parsed;

  const data = parsed.data || {};
  const models = Array.isArray(data?.models)
    ? data.models
        .map((item) => item?.name)
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim().replace(/^models\//, ""))
    : [];

  return { ok: true, models: uniqueSorted(models) };
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

  // 鍐呭瓨闄愭祦锛堢畝鍗曘€侀浂渚濊禆锛夈€俉orker 鍐峰惎鍔ㄤ細閲嶇疆锛涜嫢闇€寮轰竴鑷村彲鎺ュ叆 KV/DO銆?  const now = Date.now();
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

async function forwardChatByProvider({ provider, body, model, messages, temperature, env }) {
  if (provider === "anthropic") {
    return forwardAnthropicChat({ body, model, messages, temperature, env });
  }
  if (provider === "gemini") {
    return forwardGeminiChat({ body, model, messages, temperature, env });
  }
  return forwardOpenAICompatibleChat({ body, model, messages, temperature, env });
}

async function streamChatByProvider({ provider, body, model, messages, temperature, env, signal, onDelta }) {
  if (provider === "openai_compatible") {
    return streamOpenAICompatibleChat({ body, model, messages, temperature, env, signal, onDelta });
  }
  return streamChatByChunks({ provider, body, model, messages, temperature, env, signal, onDelta });
}

async function streamOpenAICompatibleChat({ body, model, messages, temperature, env, signal, onDelta }) {
  const cfg = getOpenAICompatibleConfig(env);
  if (!cfg.ok) return cfg;

  const upstreamUrl = buildUrl(cfg.baseUrl, cfg.chatPath);
  const payload = {
    ...(body && typeof body === "object" ? body : {}),
    model,
    messages,
    stream: true,
  };
  delete payload.provider;
  if (typeof temperature === "number") payload.temperature = temperature;

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenAICompatibleAuthHeaders(cfg),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw createAbortError();
    return { ok: false, error: "Failed to connect upstream model service." };
  }

  if (!upstreamResp.ok) {
    const text = await upstreamResp.text();
    return {
      ok: false,
      error: "Upstream request failed.",
      upstreamStatus: upstreamResp.status,
      detail: safeUpstreamError(text),
    };
  }

  const contentType = upstreamResp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const parsed = await readUpstreamJson(upstreamResp);
    if (!parsed.ok) return parsed;
    const assistant = normalizeAssistantFromUpstream(parsed.data);
    if (!assistant) {
      return { ok: false, error: "No assistant content from upstream." };
    }
    for (const chunk of chunkText(assistant.text || "", 24)) {
      if (signal?.aborted) throw createAbortError();
      await onDelta(chunk);
      await sleep(16);
    }
    return {
      ok: true,
      id: parsed.data?.id || null,
      model: parsed.data?.model || model,
      text: assistant.text || "",
      usage: parsed.data?.usage || null,
    };
  }

  let id = null;
  let finalModel = model;
  let usage = null;
  let text = "";

  await readSseStream(upstreamResp.body, async (event) => {
    if (!event?.data) return;
    if (event.data === "[DONE]") return;

    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    id = data.id || id;
    finalModel = data.model || finalModel;
    usage = data.usage || usage;

    const delta = extractOpenAIStreamText(data);
    if (!delta) return;
    text += delta;
    await onDelta(delta);
  }, signal);

  return { ok: true, id, model: finalModel, text, usage };
}

async function streamChatByChunks({ provider, body, model, messages, temperature, env, signal, onDelta }) {
  const forwarded = await forwardChatByProvider({ provider, body, model, messages, temperature, env });
  if (!forwarded.ok) return forwarded;

  const text = forwarded.assistant?.text || "";
  for (const chunk of chunkText(text, 24)) {
    if (signal?.aborted) throw createAbortError();
    await onDelta(chunk);
    await sleep(16);
  }

  return {
    ok: true,
    id: forwarded.id || null,
    model: forwarded.model || model,
    text,
    usage: forwarded.usage || null,
  };
}

async function forwardOpenAICompatibleChat({ body, model, messages, temperature, env }) {
  const cfg = getOpenAICompatibleConfig(env);
  if (!cfg.ok) return cfg;

  const upstreamUrl = buildUrl(cfg.baseUrl, cfg.chatPath);
  const payload = {
    ...(body && typeof body === "object" ? body : {}),
    model,
    messages,
    stream: false,
  };
  delete payload.provider;
  if (typeof temperature === "number") payload.temperature = temperature;

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenAICompatibleAuthHeaders(cfg),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: "Failed to connect upstream model service." };
  }

  const parsed = await readUpstreamJson(upstreamResp);
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  const assistant = normalizeAssistantFromUpstream(data);
  if (!assistant) {
    return { ok: false, error: "No assistant content from upstream." };
  }

  return {
    ok: true,
    id: data.id || null,
    model: data.model || model,
    assistant,
    usage: data.usage || null,
  };
}

async function forwardAnthropicChat({ body, model, messages, temperature, env }) {
  const cfg = getAnthropicConfig(env);
  if (!cfg.ok) return cfg;

  const transformed = toAnthropicPayload(messages, model, temperature, body, env);
  if (!transformed.ok) return transformed;

  const upstreamUrl = buildUrl(cfg.baseUrl, cfg.messagesPath);

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": cfg.version,
      },
      body: JSON.stringify(transformed.payload),
    });
  } catch {
    return { ok: false, error: "Failed to connect anthropic service." };
  }

  const parsed = await readUpstreamJson(upstreamResp);
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  const assistant = normalizeAssistantFromAnthropic(data);
  if (!assistant) {
    return { ok: false, error: "No assistant content from anthropic." };
  }

  return {
    ok: true,
    id: data.id || null,
    model: data.model || model,
    assistant,
    usage: data.usage || null,
  };
}

async function forwardGeminiChat({ body, model, messages, temperature, env }) {
  const cfg = getGeminiConfig(env);
  if (!cfg.ok) return cfg;

  const transformed = toGeminiPayload(messages, temperature, body);
  if (!transformed.ok) return transformed;

  const generatePath = resolveGeminiGeneratePath(cfg.generatePathTemplate, model);
  const upstreamUrl = buildUrl(cfg.baseUrl, generatePath);

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": cfg.apiKey,
      },
      body: JSON.stringify(transformed.payload),
    });
  } catch {
    return { ok: false, error: "Failed to connect gemini service." };
  }

  const parsed = await readUpstreamJson(upstreamResp);
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  const assistant = normalizeAssistantFromGemini(data);
  if (!assistant) {
    return { ok: false, error: "No assistant content from gemini." };
  }

  return {
    ok: true,
    id: data.responseId || data.id || null,
    model: data.modelVersion || model,
    assistant,
    usage: data.usageMetadata || data.usage || null,
  };
}

function toAnthropicPayload(messages, model, temperature, body, env) {
  const converted = convertMessagesForAnthropic(messages);
  if (!converted.messages.length) {
    return { ok: false, error: "No valid non-system messages to send to anthropic." };
  }

  const maxTokens =
    toPositiveInt(body?.max_tokens) || toPositiveInt(body?.maxTokens) || toPositiveInt(env.ANTHROPIC_MAX_TOKENS) || 1024;

  const payload = {
    model,
    messages: converted.messages,
    max_tokens: maxTokens,
  };
  if (converted.system) payload.system = converted.system;
  if (typeof temperature === "number") payload.temperature = temperature;

  return { ok: true, payload };
}

function toGeminiPayload(messages, temperature, body) {
  const converted = convertMessagesForGemini(messages);
  if (!converted.contents.length) {
    return { ok: false, error: "No valid messages to send to gemini." };
  }

  const payload = {
    contents: converted.contents,
  };
  if (converted.systemInstruction) {
    payload.system_instruction = { parts: [{ text: converted.systemInstruction }] };
  }

  const generationConfig = {};
  if (typeof temperature === "number") generationConfig.temperature = temperature;
  const maxOutputTokens =
    toPositiveInt(body?.max_output_tokens) || toPositiveInt(body?.maxOutputTokens) || toPositiveInt(body?.max_tokens);
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  if (Object.keys(generationConfig).length) {
    payload.generationConfig = generationConfig;
  }

  return { ok: true, payload };
}

function convertMessagesForAnthropic(messages) {
  const converted = [];
  const systemTexts = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role || "").toLowerCase();
    if (role === "system") {
      const sysText = flattenMessageText(normalizeMessageContent(msg?.content));
      if (sysText) systemTexts.push(sysText);
      continue;
    }

    const mappedRole = role === "assistant" ? "assistant" : "user";
    const blocks = toAnthropicContentBlocks(msg?.content);
    if (blocks.length) {
      converted.push({ role: mappedRole, content: blocks });
    }
  }

  return {
    system: systemTexts.join("\n\n"),
    messages: converted,
  };
}

function convertMessagesForGemini(messages) {
  const contents = [];
  const systemTexts = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = String(msg?.role || "").toLowerCase();
    if (role === "system") {
      const sysText = flattenMessageText(normalizeMessageContent(msg?.content));
      if (sysText) systemTexts.push(sysText);
      continue;
    }

    const mappedRole = role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(msg?.content);
    if (parts.length) {
      contents.push({ role: mappedRole, parts });
    }
  }

  return {
    systemInstruction: systemTexts.join("\n\n"),
    contents,
  };
}

function toAnthropicContentBlocks(content) {
  const blocks = [];
  for (const part of normalizeInputParts(content)) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed.base64 && parsed.mime.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
        });
      } else {
        blocks.push({ type: "text", text: "[鍥剧墖闄勪欢]" });
      }
      continue;
    }

    if (part.type === "input_audio") {
      blocks.push({ type: "text", text: "[闊抽闄勪欢]" });
      continue;
    }

    if (part.type === "file_url") {
      const parsed = parseDataUrl(part.file_url.url);
      const filename = part.file_url.filename ? ` ${part.file_url.filename}` : "";
      if (parsed.base64 && parsed.mime.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
        });
      } else {
        blocks.push({ type: "text", text: `[鏂囦欢闄勪欢${filename}]` });
      }
      continue;
    }
  }

  if (!blocks.length) {
    blocks.push({ type: "text", text: "(绌烘秷鎭?" });
  }
  return blocks;
}

function toGeminiParts(content) {
  const parts = [];
  for (const part of normalizeInputParts(content)) {
    if (part.type === "text") {
      if (part.text) parts.push({ text: part.text });
      continue;
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed.base64) {
        parts.push({
          inline_data: {
            mime_type: parsed.mime || "image/png",
            data: parsed.base64,
          },
        });
      } else {
        parts.push({ text: "[鍥剧墖闄勪欢]" });
      }
      continue;
    }

    if (part.type === "input_audio" && part.input_audio?.data) {
      const format = normalizeAudioFormat(part.input_audio.format || "mp3");
      parts.push({
        inline_data: {
          mime_type: `audio/${format}`,
          data: part.input_audio.data,
        },
      });
      continue;
    }

    if (part.type === "file_url" && part.file_url?.url) {
      const parsed = parseDataUrl(part.file_url.url);
      if (parsed.base64) {
        parts.push({
          inline_data: {
            mime_type: parsed.mime || part.file_url.media_type || "application/octet-stream",
            data: parsed.base64,
          },
        });
      } else {
        const filename = part.file_url.filename ? ` ${part.file_url.filename}` : "";
        parts.push({ text: `[鏂囦欢闄勪欢${filename}]` });
      }
      continue;
    }
  }

  if (!parts.length) {
    parts.push({ text: "(绌烘秷鎭?" });
  }
  return parts;
}

function normalizeInputParts(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    if (content == null) return [];
    if (typeof content === "object" && typeof content.text === "string") {
      return [{ type: "text", text: content.text }];
    }
    return [{ type: "text", text: stringifyUnknown(content) }];
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return { type: "text", text: part };
      }
      if (!part || typeof part !== "object") return null;
      if (typeof part.text === "string" && (part.type === "text" || part.type === "output_text" || part.type === "input_text")) {
        return { type: "text", text: part.text };
      }
      if (part.type === "image_url" && part.image_url?.url) {
        return { type: "image_url", image_url: { url: part.image_url.url } };
      }
      if (part.type === "input_audio" && part.input_audio?.data) {
        return {
          type: "input_audio",
          input_audio: {
            data: part.input_audio.data,
            format: part.input_audio.format || "mp3",
          },
        };
      }
      if (part.type === "file_url" && part.file_url?.url) {
        return {
          type: "file_url",
          file_url: {
            url: part.file_url.url,
            media_type: part.file_url.media_type || "",
            filename: part.file_url.filename || "",
          },
        };
      }
      return { type: "text", text: stringifyUnknown(part) };
    })
    .filter(Boolean);
}

function getOpenAICompatibleConfig(env) {
  const apiKey = (env.UPSTREAM_API_KEY || "").trim();
  const baseUrl = (env.UPSTREAM_BASE_URL || "").trim();
  const chatPath = (env.UPSTREAM_CHAT_PATH || "/v1/chat/completions").trim();
  const modelsPath = (env.UPSTREAM_MODELS_PATH || "/v1/models").trim();
  const apiKeyHeader = (env.UPSTREAM_API_KEY_HEADER || "Authorization").trim() || "Authorization";
  const apiKeyPrefix = env.UPSTREAM_API_KEY_PREFIX;
  if (!apiKey || !baseUrl) {
    return { ok: false, error: "Server not configured: missing UPSTREAM_API_KEY or UPSTREAM_BASE_URL." };
  }
  return { ok: true, apiKey, baseUrl, chatPath, modelsPath, apiKeyHeader, apiKeyPrefix };
}

function getAnthropicConfig(env) {
  const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
  const baseUrl = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").trim();
  const messagesPath = (env.ANTHROPIC_MESSAGES_PATH || "/v1/messages").trim();
  const modelsPath = (env.ANTHROPIC_MODELS_PATH || "/v1/models").trim();
  const version = (env.ANTHROPIC_VERSION || "2023-06-01").trim();
  if (!apiKey || !baseUrl) {
    return { ok: false, error: "Server not configured: missing ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL." };
  }
  return { ok: true, apiKey, baseUrl, messagesPath, modelsPath, version };
}

function getGeminiConfig(env) {
  const apiKey = (env.GEMINI_API_KEY || "").trim();
  const baseUrl = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").trim();
  const generatePathTemplate = (env.GEMINI_GENERATE_PATH_TEMPLATE || "/v1beta/models/{model}:generateContent").trim();
  const modelsPath = (env.GEMINI_MODELS_PATH || "/v1beta/models").trim();
  if (!apiKey || !baseUrl) {
    return { ok: false, error: "Server not configured: missing GEMINI_API_KEY or GEMINI_BASE_URL." };
  }
  return { ok: true, apiKey, baseUrl, generatePathTemplate, modelsPath };
}

function buildUrl(baseUrl, pathPart) {
  return `${baseUrl.replace(/\/$/, "")}${String(pathPart || "").startsWith("/") ? pathPart : `/${pathPart}`}`;
}

function buildOpenAICompatibleAuthHeaders(cfg) {
  const headerName = String(cfg?.apiKeyHeader || "Authorization").trim() || "Authorization";
  if (headerName.toLowerCase() === "authorization") {
    const prefix = cfg?.apiKeyPrefix == null ? "Bearer " : String(cfg.apiKeyPrefix);
    return { [headerName]: `${prefix}${cfg.apiKey}`.trim() };
  }
  return { [headerName]: cfg.apiKey };
}

async function readSseStream(stream, onEvent, signal) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) throw createAbortError();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = findSseBoundary(buffer);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer.slice(boundary, boundary + 4).startsWith("\r\n\r\n") ? 4 : 2));
      const parsed = parseSseEvent(rawEvent);
      if (parsed) await onEvent(parsed);
      boundary = findSseBoundary(buffer);
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer);
    if (parsed) await onEvent(parsed);
  }
}

function parseSseEvent(rawEvent) {
  const lines = String(rawEvent || "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (!lines.length) return null;
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

function findSseBoundary(buffer) {
  const rn = buffer.indexOf("\r\n\r\n");
  const nn = buffer.indexOf("\n\n");
  if (rn === -1) return nn;
  if (nn === -1) return rn;
  return Math.min(rn, nn);
}

function extractOpenAIStreamText(data) {
  if (data?.type === "response.output_text.delta" && typeof data.delta === "string") {
    return data.delta;
  }

  const choices = Array.isArray(data?.choices) ? data.choices : [];
  let text = "";
  for (const choice of choices) {
    const content = choice?.delta?.content;
    if (typeof content === "string") {
      text += content;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") text += part.text;
      }
    }
  }
  return text;
}

function chunkText(text, size = 24) {
  const input = String(text || "");
  if (!input) return [];
  const chunks = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function resolveGeminiGeneratePath(template, model) {
  const rawModel = String(model || "").trim().replace(/^models\//, "");
  const encodedModel = encodeURIComponent(rawModel);
  if (String(template).includes("{model}")) {
    return String(template).replace("{model}", encodedModel);
  }
  const clean = String(template || "").replace(/\/$/, "");
  return `${clean}/${encodedModel}:generateContent`;
}

async function readUpstreamJson(resp) {
  const text = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      error: "Upstream request failed.",
      upstreamStatus: resp.status,
      detail: safeUpstreamError(text),
    };
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Upstream returned non-JSON response." };
  }
}

function uniqueSorted(list) {
  return [...new Set((list || []).filter(Boolean))].sort();
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function parseDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return { mime: "", base64: "" };
  const comma = url.indexOf(",");
  if (comma === -1) return { mime: "", base64: "" };
  const meta = url.slice(5, comma);
  const mime = (meta.split(";")[0] || "").trim();
  const base64 = meta.includes(";base64") ? url.slice(comma + 1) : "";
  return { mime: mime || "application/octet-stream", base64 };
}

function buildDataUrl(mime, base64) {
  if (!base64) return "";
  return `data:${mime || "application/octet-stream"};base64,${base64}`;
}

function normalizeAudioFormat(format) {
  const f = String(format || "").toLowerCase();
  if (f === "mpeg") return "mp3";
  if (f === "wave" || f === "x-wav") return "wav";
  return f || "mp3";
}

function safeUpstreamError(text) {
  if (!text) return "unknown";
  return text.slice(0, 500);
}

function normalizeAssistantFromUpstream(data) {
  const message = extractAssistantMessage(data);
  if (!message) return null;
  const text = flattenMessageText(message.content);
  return { message, text };
}

function normalizeAssistantFromAnthropic(data) {
  const parts = [];
  if (Array.isArray(data?.content)) {
    for (const block of data.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block?.type === "image" && block.source?.data) {
        const mime = block.source.media_type || "image/png";
        parts.push({ type: "image_url", image_url: { url: buildDataUrl(mime, block.source.data) } });
      } else if (block && typeof block === "object") {
        parts.push({ type: "text", text: stringifyUnknown(block) });
      }
    }
  }

  if (!parts.length && typeof data?.completion === "string" && data.completion.trim()) {
    parts.push({ type: "text", text: data.completion });
  }
  if (!parts.length) return null;

  const message = { role: "assistant", content: parts };
  return { message, text: flattenMessageText(message.content) };
}

function normalizeAssistantFromGemini(data) {
  const candidate = Array.isArray(data?.candidates)
    ? data.candidates.find((item) => Array.isArray(item?.content?.parts))
    : null;
  const rawParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const parts = [];

  for (const part of rawParts) {
    if (typeof part?.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    const inline = part?.inline_data || part?.inlineData;
    if (inline?.data) {
      const mime = inline.mime_type || inline.mimeType || "application/octet-stream";
      if (mime.startsWith("image/")) {
        parts.push({ type: "image_url", image_url: { url: buildDataUrl(mime, inline.data) } });
      } else if (mime.startsWith("audio/")) {
        parts.push({
          type: "input_audio",
          input_audio: {
            data: inline.data,
            format: normalizeAudioFormat(mime.split("/")[1] || "mp3"),
          },
        });
      } else {
        parts.push({
          type: "file_url",
          file_url: {
            url: buildDataUrl(mime, inline.data),
            media_type: mime,
            filename: "",
          },
        });
      }
      continue;
    }
    if (part && typeof part === "object") {
      parts.push({ type: "text", text: stringifyUnknown(part) });
    }
  }

  if (!parts.length) return null;
  const message = { role: "assistant", content: parts };
  return { message, text: flattenMessageText(message.content) };
}

function extractAssistantMessage(data) {
  const choiceMessage = data?.choices?.find((choice) => choice?.message)?.message;
  if (choiceMessage && typeof choiceMessage === "object") {
    return normalizeMessage(choiceMessage);
  }

  const outputMessage = Array.isArray(data?.output)
    ? data.output.find((item) => item?.type === "message" && Array.isArray(item?.content))
    : null;
  if (outputMessage) {
    return {
      role: "assistant",
      content: normalizeMessageContent(outputMessage.content),
    };
  }

  if (data?.message && typeof data.message === "object") {
    return normalizeMessage(data.message);
  }

  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return { role: "assistant", content: data.output_text };
  }

  return null;
}

function normalizeMessage(message) {
  return {
    role: typeof message.role === "string" ? message.role : "assistant",
    content: normalizeMessageContent(message.content),
  };
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content == null) return "";
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return stringifyUnknown(content);
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return { type: "text", text: part };
      }
      if (!part || typeof part !== "object") return null;
      if (typeof part.text === "string" && (part.type === "text" || part.type === "output_text" || part.type === "input_text")) {
        return { type: "text", text: part.text };
      }
      if (part.type === "image_url" && part.image_url?.url) {
        return { type: "image_url", image_url: { url: part.image_url.url } };
      }
      if (part.type === "input_audio" && part.input_audio?.data) {
        return {
          type: "input_audio",
          input_audio: {
            data: part.input_audio.data,
            format: part.input_audio.format || "mp3",
          },
        };
      }
      if (part.type === "file_url" && part.file_url?.url) {
        return {
          type: "file_url",
          file_url: {
            url: part.file_url.url,
            media_type: part.file_url.media_type || "",
            filename: part.file_url.filename || "",
          },
        };
      }
      return { type: "text", text: stringifyUnknown(part) };
    })
    .filter(Boolean);
}

function flattenMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const texts = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      texts.push(part.text);
    } else if (typeof part.content === "string") {
      texts.push(part.content);
    }
  }

  return texts.join("\n").trim();
}

function stringifyUnknown(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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


