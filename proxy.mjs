import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";

// ── Environment ─────────────────────────────────────────────────────────────
const ANTHROPIC_TOKEN = process.env.ANTHROPIC;
const UPSTREAM_URL = new URL(process.env.ANTHROPIC_URL || "https://gateway.runloop.ai");
const CA_BUNDLE_PATH = process.env.CURL_CA_BUNDLE || process.env.NODE_EXTRA_CA_CERTS || "/etc/ssl/certs/ca-certificates.crt";
const PORT = parseInt(process.env.PROXY_PORT || "8080", 10);

if (!ANTHROPIC_TOKEN) {
  console.error("[FATAL] ANTHROPIC environment variable is not set. Exiting.");
  process.exit(1);
}

let ca;
try {
  ca = readFileSync(CA_BUNDLE_PATH);
  console.log(`[BOOT] Loaded CA bundle from ${CA_BUNDLE_PATH}`);
} catch (err) {
  console.error(`[WARN] Could not load CA bundle from ${CA_BUNDLE_PATH}: ${err.message}`);
  console.error("[WARN] Upstream TLS verification may fail.");
}

// ── Proxy Server ────────────────────────────────────────────────────────────
const BOOT_TIME = Date.now();

const server = createServer((clientReq, clientRes) => {
  // ── Health Check ────────────────────────────────────────────────────────
  if (clientReq.method === "GET" && clientReq.url === "/health") {
    const uptime = Math.floor((Date.now() - BOOT_TIME) / 1000);
    clientRes.writeHead(200, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ status: "ok", uptime, upstream: UPSTREAM_URL.hostname }));
    return;
  }

  const startTime = Date.now();

  // ── A. Route Rewriting ──────────────────────────────────────────────────
  const upstreamPath = clientReq.url;

  // ── B. Auth Injection ───────────────────────────────────────────────────
  const headers = { ...clientReq.headers };

  delete headers["authorization"];
  delete headers["x-api-key"];

  headers["x-api-key"] = ANTHROPIC_TOKEN;

  // ── D. Host Header Rewrite ──────────────────────────────────────────────
  headers["host"] = UPSTREAM_URL.host;

  delete headers["connection"];
  delete headers["transfer-encoding"];

  // ── C. TLS Bridging — build upstream request ────────────────────────────
  const upstreamOpts = {
    hostname: UPSTREAM_URL.hostname,
    port: UPSTREAM_URL.port || 443,
    path: upstreamPath,
    method: clientReq.method,
    headers,
    ...(ca ? { ca } : {}),
  };

  const upstreamReq = httpsRequest(upstreamOpts, (upstreamRes) => {
    const elapsed = Date.now() - startTime;
    console.log(
      `[PROXY] ${clientReq.method} ${upstreamPath} -> ${UPSTREAM_URL.hostname}${upstreamPath} ${upstreamRes.statusCode} (${elapsed}ms)`
    );

    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders["transfer-encoding"];

    clientRes.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on("error", (err) => {
    console.error(`[ERROR] Upstream request failed: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    }
  });

  clientReq.on("error", (err) => {
    console.error(`[ERROR] Client request error: ${err.message}`);
    upstreamReq.destroy();
  });

  clientReq.pipe(upstreamReq);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] Transparent proxy listening on 0.0.0.0:${PORT}`);
  console.log(`[BOOT] Upstream target: ${UPSTREAM_URL.origin}`);
  console.log(`[BOOT] Auth token loaded: ${ANTHROPIC_TOKEN.substring(0, 8)}...`);
  console.log("[BOOT] Interceptors active: URL-Rewrite | Auth-Inject | TLS-Bridge | Host-Rewrite");
});

server.on("error", (err) => {
  console.error(`[FATAL] Server error: ${err.message}`);
  process.exit(1);
});
