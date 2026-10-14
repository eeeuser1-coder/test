# OpenAI Responses forwarding proxy

Node.js 24+，仅使用内置模块，无需安装 npm 依赖。

## 功能

- 仅透传 `/v1/responses` 及安全的子路径，支持普通响应和 SSE。
- `/v1/chat/completions` 和其他 API 路径直接返回 404，鉴权失败也不转发这些路径。
- 外部 `Authorization: Bearer` 通过校验后移除，上游使用独立内部鉴权。
- `/` 为健康监控页，`/healthz` 为代理存活检查，`/status` 为状态 JSON。监控每 60 秒刷新。
- 目标固定为 `https://api.openai.com/v1`，请求方法、原始请求体、查询参数、响应状态和响应体透传；逐跳 HTTP 头及 CF 转发元数据移除。

## 配置和启动

在仓库根目录创建 `access-token`，内容为外部 API Key，权限设为 `600`。密钥文件已加入 `.gitignore`，不要提交密钥。

上游内部鉴权使用 `OPENAI_API_KEY`，或内容为内部 Key、权限为 `600` 的 `upstream-api-key` 文件。外部和内部 Key 必须不同。内部文件每次请求读取，无需重启；外部 Key 更新后重启代理。

没有独立内部 Key 时不添加上游 Authorization，仅适用于环境已提供托管 Responses 鉴权的情况。常规环境需要配置真实的上游 Key。

```sh
chmod 600 access-token
# 如使用文件提供上游 Key：chmod 600 upstream-api-key
npm start
```

默认监听 `127.0.0.1:8787`，可用 `PROXY_PORT` 修改端口。健康监控页不展示密钥。

## Cloudflare Tunnel

安装官方 [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) 后，在另一个持续运行的终端执行：

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --protocol http2 --no-autoupdate
```

将新进程输出中的 `https://….trycloudflare.com` 地址保存到仓库根目录 `public-url`。监控会检查该地址的 `/healthz`。Quick Tunnel 重启后域名会变化，需更新文件。使用 HTTP/2 可避免环境不支持 QUIC 导致的连接失败。

## 调用

```sh
BASE_URL='https://YOUR-TUNNEL.trycloudflare.com/v1'
API_KEY="$(cat access-token)"
curl "$BASE_URL/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1-nano","input":"hello","max_output_tokens":16,"store":false}'
```

设置 `"stream":true` 使用 SSE。监控的 Models 网络探测不会调用生成接口；未配置内部 Key 时 HTTP 401 仅表示网络可达、接口需要认证，不表示已认证成功。

## 定时检查

`npm start` 启动的后台健康探测每 60 秒运行，页面打开时也每 60 秒刷新。它们无法保证平台不挂起沙箱。Coding Agent 的定时唤醒任务独立于本仓库，目前按用户要求暂停。

可将 `schedule.example.json` 复制为 `schedule.json`，让页面显示暂停状态。该文件只是 UI 状态，不会创建或修改平台定时任务。

## 验证

```sh
npm run check
npm test
```

测试在临时目录使用合成密钥和本地上游，不需要 OpenAI 凭据，也不会请求真实模型。覆盖 Responses 原始字节/查询/SSE 透传、内外鉴权分离、拒绝错误外部密钥、禁用接口 404、内部 Key 与外部 Key 相同的拒绝处理。
