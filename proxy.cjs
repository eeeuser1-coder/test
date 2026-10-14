const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const token = Buffer.from(fs.readFileSync(__dirname + '/access-token', 'utf8').trim());
const monitor = require('./monitor.cjs');
const internalAuth = require('./upstream-auth.cjs');
const page = fs.readFileSync(__dirname + '/monitor.html');
const port = Number(process.env.PROXY_PORT || 8787);
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersWithoutHop(headers) {
  const blocked = new Set([...hop, ...(headers.connection || '').split(',').map(x => x.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, {'content-type':'application/json', 'cache-control':'no-store'});
    return res.end(JSON.stringify({status:'ok', upstream:'https://api.openai.com/v1'}));
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
    res.writeHead(200, {'content-type': req.url === '/' ? 'text/html; charset=utf-8' : 'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff'});
    return res.end(req.url === '/' ? page : JSON.stringify(monitor.snapshot()));
  }
  const routePath = req.url.split('?')[0];
  if (!/^\/v1\/responses(?:\/[A-Za-z0-9_-]+)*\/?$/.test(routePath) || req.url.includes('#')) {
    req.resume();
    res.writeHead(404, {'content-type':'application/json'});
    return res.end(JSON.stringify({error:{message:'Not found',type:'proxy_not_found'}}));
  }
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  const supplied = Buffer.from(match ? match[1] : '');
  if (supplied.length !== token.length || !crypto.timingSafeEqual(supplied, token)) {
    res.writeHead(401, {'content-type':'application/json', 'www-authenticate':'Bearer'});
    req.resume();
    return res.end(JSON.stringify({error:{message:'Missing or invalid Authorization: Bearer API_KEY',type:'proxy_authentication_error'}}));
  }
  const headers = headersWithoutHop(req.headers);
  headers.host = 'api.openai.com';
  delete headers['x-proxy-token'];
  // Never send the validated external gateway token to OpenAI.
  delete headers.authorization;
  try {
    const internalKey = internalAuth.key();
    if (internalKey && internalKey === token.toString()) throw new Error('Internal and external keys must differ');
    if (internalKey) headers.authorization = 'Bearer ' + internalKey;
  } catch {
    req.resume();
    res.writeHead(503, {'content-type':'application/json'});
    return res.end(JSON.stringify({error:{message:'Internal authentication configuration is invalid',type:'proxy_configuration_error'}}));
  }
  // Cloudflare visitor metadata is not part of the upstream API request.
  for (const name of Object.keys(headers)) if (name.startsWith('cf-') || name.startsWith('x-forwarded-')) delete headers[name];
  const upstream = https.request({hostname:'api.openai.com', port:443, path:req.url, method:req.method, headers}, incoming => {
    const forwarded = headersWithoutHop(incoming.headers);
    res.writeHead(incoming.statusCode, forwarded);
    pipeline(incoming, res, () => {});
  });
  upstream.setTimeout(180000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, {'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'Upstream connection failed',type:'proxy_upstream_error'}}));
    } else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  pipeline(req, upstream, () => {});
});
server.headersTimeout = 30000;
server.requestTimeout = 180000;
server.listen(port, '127.0.0.1', () => {console.log('OpenAI forwarding proxy listening at http://127.0.0.1:' + port); monitor.start();});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {server.close(() => process.exit(0)); setTimeout(() => process.exit(0),5000).unref();});

module.exports = server;
