# Transparent API Proxy

Stateless L7 proxy that bridges external API requests to the internal Runloop gateway.

```
External Client → Cloudflare Tunnel → localhost:PORT → Proxy → gateway.runloop.ai
```

## Interceptors

| # | Interceptor | Description |
|---|-------------|-------------|
| A | URL Rewrite | Forwards incoming path to `ANTHROPIC_URL` |
| B | Auth Inject | Strips external credentials, injects `ANTHROPIC` token as `x-api-key` + `Authorization: Bearer` |
| C | TLS Bridge  | Loads custom CA bundle from `CURL_CA_BUNDLE` for upstream HTTPS |
| D | Host Rewrite | Sets `Host` header to upstream hostname |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC` | Yes | — | Internal gateway auth token |
| `ANTHROPIC_URL` | No | `https://gateway.runloop.ai` | Upstream base URL |
| `CURL_CA_BUNDLE` | No | `/etc/ssl/certs/ca-certificates.crt` | Path to CA certificate bundle |
| `PROXY_PORT` | No | `8080` | Local listening port |

## Usage

```bash
npm start
```

## Zero Dependencies

Uses only Node.js built-in modules (`http`, `https`, `fs`). No `npm install` required.
