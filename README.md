# MyAI Mobile（HTML + 安全中转）

这是一个适合手机轻环境的最小方案：
- 前端：纯 `HTML` 聊天页，可切换模型并上传图片/音频/视频/文件。
- 后端：`Cloudflare Worker` 中转，真实上游 `API Key` 仅保存在服务端。
- 新增：`Node` 服务端（`server.js`），可部署到 Render/Railway，电脑无需常开。

## 1. 为什么这样做

纯前端无法保护 Key。这个项目通过后端代理实现：
1. 朋友只拿到访问口令（`X-Client-Token`），拿不到你的上游 Key。
2. 你可在服务端按需控制模型白名单、速率和来源（也可关闭限制）。

## 2. 目录结构

- `worker.js`：API 中转与鉴权逻辑（`/api/models`、`/api/chat`）
- `server.js`：Node 版中转与静态服务（可部署到 Render/Railway）
- `wrangler.toml`：Worker 配置
- `public/index.html`：手机聊天页面
- `public/sw.js`：PWA 离线壳
- `public/manifest.webmanifest`：PWA 清单
- `render.yaml`：Render 一键部署配置

## 3. 配置

先准备以下环境变量（Worker 可在 `wrangler.toml` 配，Node 云部署在平台控制台配）：
- `UPSTREAM_PROVIDER`：默认提供商（`openai_compatible` / `anthropic` / `gemini`）
- `ALLOWED_MODELS`：逗号分隔模型白名单；留空表示不限制模型
- `ACCESS_TOKENS`：给朋友发的访问口令（逗号分隔）
- `ALLOWED_ORIGINS`：可选，限制来源域名
- `RATE_LIMIT_PER_MIN`：每个口令每分钟请求上限；`0` 或负数表示不限制
- `MAX_BODY_SIZE_MB`：仅 Node 服务端生效，控制单次请求体上限（默认 `100`，用于多媒体上传）

OpenAI 兼容 provider 变量：
- `UPSTREAM_API_KEY`
- `UPSTREAM_BASE_URL`（不带末尾 `/`）
- `UPSTREAM_CHAT_PATH`（默认 `/v1/chat/completions`）
- `UPSTREAM_MODELS_PATH`（默认 `/v1/models`）

Anthropic 原生 provider 变量：
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`（默认 `https://api.anthropic.com`）
- `ANTHROPIC_MESSAGES_PATH`（默认 `/v1/messages`）
- `ANTHROPIC_MODELS_PATH`（默认 `/v1/models`）
- `ANTHROPIC_VERSION`（默认 `2023-06-01`）

Gemini 原生 provider 变量：
- `GEMINI_API_KEY`
- `GEMINI_BASE_URL`（默认 `https://generativelanguage.googleapis.com`）
- `GEMINI_GENERATE_PATH_TEMPLATE`（默认 `/v1beta/models/{model}:generateContent`）
- `GEMINI_MODELS_PATH`（默认 `/v1beta/models`）

先安装依赖（PowerShell 建议用 `npm.cmd`）：

```bash
npm.cmd install
```

再设置真实上游 Key（不要写进代码仓库）：

```bash
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

## 4. 本地调试

```bash
npm.cmd run dev
```

浏览器访问本地地址后：
1. 在页面里填访问口令（你配置在 `ACCESS_TOKENS` 的值）。
2. 在设置里选择 provider（OpenAI 兼容 / Anthropic / Gemini）。
3. 模型列表会从 `/api/models?provider=...` 拉取；若上游不支持列表接口，也可手动输入模型名。
4. 支持上传图片/音频/视频/文件（默认单文件 20MB、最多 5 个、总计 80MB；附件会以内联数据发送到上游）。
5. 若当前模型不适配附件类型（如音频/视频/图片），前端会在当前 provider 下自动切换到更合适的模型并提示。
6. 发送消息由 `/api/chat` 转发到上游。

### 手机直连本机（不依赖 workers.dev）

如果你当前网络打不开 `workers.dev`，可先用同一 Wi-Fi 局域网访问：

```bash
npm.cmd run dev:lan
```

然后在手机浏览器打开：

```text
http://<你的电脑局域网IP>:8787
```

在 Windows 可用 `ipconfig` 查 IP。示例：`10.76.158.100`，则手机地址是 `http://10.76.158.100:8787`。

### 临时公网分享（不依赖 workers.dev）

如果朋友不在同一局域网，可使用临时隧道：

1. 终端 A 启动本地服务

```bash
npm.cmd run dev:lan
```

2. 终端 B 启动公网隧道

```bash
npm.cmd run share
```

3. 复制终端输出中的 `https://xxxx.loca.lt` 给朋友访问

注意：
- 该链接是临时的，重启隧道会变化。
- 关闭任一终端后链接会失效。

## 5. 长期开放（推荐，不需要你电脑一直运行）

使用 `server.js` 部署到 Render/Railway：

```bash
npm.cmd run start
```

本地先用上面命令验证；云端平台会自动注入 `PORT`。

必填环境变量（在平台控制台设置）：
- `UPSTREAM_PROVIDER`
- `ACCESS_TOKENS`
- 以及与 `UPSTREAM_PROVIDER` 对应的一组 Key / Base URL（见上方“配置”章节）

可选环境变量：
- `UPSTREAM_CHAT_PATH`（OpenAI 兼容默认 `/v1/chat/completions`）
- `UPSTREAM_MODELS_PATH`（OpenAI 兼容默认 `/v1/models`）
- `ANTHROPIC_MESSAGES_PATH`、`ANTHROPIC_MODELS_PATH`、`ANTHROPIC_VERSION`
- `GEMINI_GENERATE_PATH_TEMPLATE`、`GEMINI_MODELS_PATH`
- `ALLOWED_MODELS`（留空=不限模型）
- `ALLOWED_ORIGINS`（留空=不限制来源）
- `RATE_LIMIT_PER_MIN`（`0`=不限流）
- `MAX_BODY_SIZE_MB`（默认 `100`，多媒体场景建议按需调大）

Render 可直接使用仓库内 `render.yaml` 创建服务。

## 6. Worker 部署（可选）

```bash
npm.cmd run deploy
```

部署完成后把 Worker 域名发给朋友即可。

## 7. 关于 VPN（Worker 场景）

- 朋友是否需要 VPN，取决于他们是否能访问你的 Worker 域名。
- 朋友端不直接连第三方 API，只连你的服务，通常不需要 VPN。
- 但你的 Worker 所在网络必须能连通第三方 API。

## 8. 安全建议（建议执行）

1. 给每个朋友单独口令，泄露可单独失效。
2. 开启并收紧 `ALLOWED_ORIGINS`。
3. 如需控费可再启用白名单或限流。
4. 不要把上游 Key 写到 `index.html`、`localStorage` 或公开仓库。

## 9. 说明

当前限流是 Worker 内存限流，简单易用但不是强一致（冷启动会重置）。如果后续你要更严格统计，我可以帮你升级为 KV/DO 版本。
