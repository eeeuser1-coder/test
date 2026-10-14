const http=require('node:http'), https=require('node:https'), fs=require('node:fs'), assert=require('node:assert/strict');
const path=require('node:path'), os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'responses-proxy-test-'));
for(const file of ['proxy.cjs','upstream-auth.cjs','monitor.cjs','monitor.html']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
const external='synthetic-external-key';
fs.writeFileSync(path.join(root,'access-token'),external,{mode:0o600});
fs.writeFileSync(path.join(root,'schedule.json'),JSON.stringify({status:'paused',minutes:null}));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const internal='synthetic-internal-key-for-local-fixture';
const captured=[];
const fixture=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
 if(req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/responses')){
  captured.push({path:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks)});
  if(req.url.includes('stream=true')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"fixture":true}\n\n');res.end('data: [DONE]\n\n');}
  else {res.writeHead(207,{'content-type':'application/json','x-fixture':'pass'});res.end('{ "fixture" : "原样响应" }');}
 } else {res.writeHead(200,{'content-type':'application/json'});res.end('{}');}
});});
const send=(port,path,body,auth,method='POST')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{'Content-Type':'application/json','X-Client-Test':'raw-header',...(auth?{Authorization:auth}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);});
fixture.listen(0,'127.0.0.1',async()=>{
 try{
  const fixturePort=fixture.address().port;
  // Redirect every test-process upstream request locally, so synthetic auth never reaches a real service.
  https.request=(opts,cb)=>http.request({...opts,hostname:'127.0.0.1',port:fixturePort,protocol:'http:'},cb);
  https.get=(url,opts,cb)=>{const u=new URL(url);const req=http.request({hostname:'127.0.0.1',port:fixturePort,path:u.pathname+u.search,method:'GET',headers:opts.headers},cb);req.end();return req;};
  process.env.OPENAI_API_KEY=internal;process.env.PROXY_PORT='0';const proxy=require(root+'/proxy.cjs');
  await new Promise(resolve=>proxy.once('listening',resolve));const proxyPort=proxy.address().port;
  const health=await send(proxyPort,'/healthz',undefined,null,'GET');assert.equal(health.status,200);
  const status=await send(proxyPort,'/status',undefined,null,'GET');const state=JSON.parse(status.body);
  assert.equal(state.intervalSeconds,60);assert.equal(state.scheduledCheckStatus,'paused');assert.equal(state.scheduledCheckMinutes,null);
  assert.ok(!status.body.toString().includes(external));assert.ok(!status.body.toString().includes(internal));
  const page=await send(proxyPort,'/',undefined,null,'GET');assert.equal(page.status,200);
  const script=page.body.toString().match(/<script>([\s\S]*?)<\/script>/)[1];new (require('node:vm').Script)(script);
  const body=Buffer.from('{  "model": "fixture-model", "text": "你好", "unknown": [1, 2] }\n');
  for(const path of ['/v1/responses?fixture=1','/v1/responses?stream=true']){
   const r=await send(proxyPort,path,body,'Bearer '+external), c=captured.at(-1);
   assert.equal(c.path,path);assert.equal(c.method,'POST');assert.deepEqual(c.body,body);
   assert.equal(c.headers.authorization,'Bearer '+internal);assert.notEqual(c.headers.authorization,'Bearer '+external);assert.equal(c.headers['x-client-test'],'raw-header');assert.equal(c.headers['x-proxy-token'],undefined);
   if(path.includes('stream=true')){assert.equal(r.status,200);assert.equal(r.body.toString(),'data: {"fixture":true}\n\ndata: [DONE]\n\n');}else{assert.equal(r.status,207);assert.equal(r.headers['x-fixture'],'pass');assert.equal(r.body.toString(),'{ "fixture" : "原样响应" }');}
   console.log(JSON.stringify({check:path,pass:true,requestBytesUnchanged:true,externalAuthRemoved:true,internalAuthApplied:true,responseBytesUnchanged:true}));
  }
  const count=captured.length;
  for(const auth of [null,'Bearer invalid']){const r=await send(proxyPort,'/v1/responses',body,auth);assert.equal(r.status,401);assert.equal(captured.length,count);}
  for(const path of ['/v1/chat/completions','/v1/chat/completions?x=1','/v1/models','/v1/responses/../chat/completions']) {
    for(const auth of [null,'Bearer '+external]){const r=await send(proxyPort,path,body,auth);assert.equal(r.status,404);assert.equal(captured.length,count);}
  }
  process.env.OPENAI_API_KEY=external;
  const identical=await send(proxyPort,'/v1/responses',body,'Bearer '+external);assert.equal(identical.status,503);assert.equal(captured.length,count);
  console.log('PASS: Responses passthrough/SSE/internal auth, rejected auth, disabled paths return404 without upstream');process.exit(0);
 }catch(e){console.error(e.message);process.exit(1);}
});
