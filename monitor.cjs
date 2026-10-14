const https = require('node:https');
const fs = require('node:fs');
const internalAuth = require('./upstream-auth.cjs');
const state = {intervalSeconds:60, checkedAt:null, upstream:{ok:false, message:'等待首次检查'}, tunnel:{ok:false, message:'等待首次检查'}};
function publicUrl() {
  try { const u = new URL(fs.readFileSync(__dirname + '/public-url','utf8').trim()); return u.protocol === 'https:' && u.hostname.endsWith('.trycloudflare.com') ? u.origin : null; } catch {return null;}
}
function probe(url, acceptAuthenticationChallenge = false, authorization = null) {
  return new Promise(resolve => {
    const start = Date.now();
    const req = https.get(url, {headers:{'user-agent':'OpenAI-Proxy-Health/1.0', ...(authorization ? {authorization} : {})}}, res => {
      res.resume();
      resolve({ok:res.statusCode === 200 || (acceptAuthenticationChallenge && res.statusCode === 401), authenticationRequired:res.statusCode === 401, status:res.statusCode, latencyMs:Date.now()-start, message:'HTTP ' + res.statusCode + (acceptAuthenticationChallenge && res.statusCode === 401 ? ' · 网络可达，需 API Key' : '')});
    });
    req.setTimeout(8000, () => req.destroy(new Error('请求超时')));
    req.on('error', e => resolve({ok:false, latencyMs:Date.now()-start, message:e.code || '连接失败'}));
  });
}
let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try {
    const url = publicUrl();
    let key; try {key = internalAuth.key();} catch {key = null;}
    const [upstream,tunnel] = await Promise.all([probe('https://api.openai.com/v1/models', !key, key ? 'Bearer ' + key : null), url ? probe(url + '/healthz') : Promise.resolve({ok:false,message:'隧道地址未配置'})]);
    Object.assign(state, {upstream,tunnel,checkedAt:new Date().toISOString()});
  } finally {checking = false;}
}
exports.start = () => {check(); setInterval(check,60000).unref();};
exports.snapshot = () => ({...state,internalAuthConfigured:internalAuth.configured(),proxy:{ok:true,message:'服务运行中',uptimeSeconds:Math.floor(process.uptime())},publicApiBase:publicUrl() ? publicUrl() + '/v1' : null, scheduledCheckStatus: (()=>{try{return JSON.parse(fs.readFileSync(__dirname+'/schedule.json','utf8')).status;}catch{return null;}})(), scheduledCheckMinutes: (()=>{try{return JSON.parse(fs.readFileSync(__dirname+'/schedule.json','utf8')).minutes;}catch{return null;}})()});
