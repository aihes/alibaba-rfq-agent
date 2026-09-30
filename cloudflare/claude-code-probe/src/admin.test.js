import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { requireAccessAdmin, clientConfig, publicClient } from './admin-auth.js';
const env = { ACCESS_TEAM_DOMAIN: 'https://rfq-test.cloudflareaccess.com', ACCESS_AUD: 'admin-app', ADMIN_EMAILS: 'aihehe123@gmail.com' };
const keys = await generateKeyPair('RS256');
async function token(email=env.ADMIN_EMAILS, key=keys.privateKey, aud=env.ACCESS_AUD, exp='5m') {
 return new SignJWT({email}).setProtectedHeader({alg:'RS256'}).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(aud).setSubject('test').setIssuedAt().setExpirationTime(exp).sign(key);
}
function req(jwt, method='GET', origin='https://glm.knowflow.work') {
 return new Request('https://glm.knowflow.work/admin/api/clients',{method,headers:{...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),Origin:origin,'X-RFQ-Admin':'1'}});
}
test('admin fails closed and accepts only signed allowed identity',async()=>{
 await assert.rejects(requireAccessAdmin(req(),{}),e=>e.status===503);
 await assert.rejects(requireAccessAdmin(req(),env),e=>e.status===401);
 await assert.rejects(requireAccessAdmin(req(await token('other@example.com')),env,keys.publicKey),e=>e.status===403);
 assert.equal(await requireAccessAdmin(req(await token()),env,keys.publicKey),env.ADMIN_EMAILS);
});
test('forged, expired and wrong audience JWTs fail',async()=>{
 const other=await generateKeyPair('RS256');
 for(const jwt of [await token(env.ADMIN_EMAILS,other.privateKey),await token(env.ADMIN_EMAILS,keys.privateKey,'other'),await token(env.ADMIN_EMAILS,keys.privateKey,env.ACCESS_AUD,1)]) await assert.rejects(requireAccessAdmin(req(jwt),env,keys.publicKey),e=>e.status===401);
});
test('writes require same origin and custom header',async()=>{
 const jwt=await token();
 await assert.rejects(requireAccessAdmin(req(jwt,'POST','https://evil.example'),env,keys.publicKey),e=>e.status===403);
 const r=req(jwt,'PATCH');r.headers.delete('X-RFQ-Admin');
 await assert.rejects(requireAccessAdmin(r,env,keys.publicKey),e=>e.status===403);
 assert.equal(await requireAccessAdmin(req(jwt,'POST'),env,keys.publicKey),env.ADMIN_EMAILS);
});
test('quota validation and no credentials or stale usage in list',()=>{
 assert.deepEqual(clientConfig({name:' test ',daily_agent_limit:20,daily_ocr_limit:100}),{name:'test',agent:20,ocr:100});
 for(const n of [0,-1,501,1.5,'20']) assert.throws(()=>clientConfig({name:'x',daily_agent_limit:n,daily_ocr_limit:100}));
 const record=publicClient({id:'id',name:'test',token:'secret',hash:'secret',dailyAgentLimit:20,dailyOcrLimit:100,usage:{day:'2000-01-01',agent:10,ocr:20}},'2026-09-30');
 assert.equal(JSON.stringify(record).includes('secret'),false);assert.equal(record.usage.agent,0);
});

test('stored clients paginate, edit without resetting usage and revoke authentication', async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('./index.js',import.meta.url),'utf8');
 const classSource=source.slice(source.indexOf('export class ClaudeCodeProbe'),source.indexOf('function requireAdmin')).replace('export class','class');
 const Probe=runInNewContext(classSource+';ClaudeCodeProbe',{Container:class{},crypto,publicClient,btoa,tokenHash:async x=>{const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));return Buffer.from(hash).toString('hex')}});
 const data=new Map();const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),transaction:async fn=>fn(storage),list:async opts=>new Map([...data].filter(([k])=>k.startsWith(opts.prefix)&&(!opts.startAfter||k>opts.startAfter)).sort(([a],[b])=>a.localeCompare(b)).slice(0,opts.limit))};
 const p=new Probe();p.ctx={storage};const c=await p.createClient('customer',20,100);
 assert.equal((await p.authenticate(c.token)).client_id,c.client_id);
 const h=await storage.get('client-id:'+c.client_id);const rec=await storage.get('client:'+h);rec.usage={day:new Date().toISOString().slice(0,10),agent:7,ocr:9};await storage.put('client:'+h,rec);
 const edited=await p.updateClient(c.client_id,'updated',30,200);assert.equal(edited.client.usage.agent,7);assert.equal(edited.client.name,'updated');
 for(let i=0;i<100;i++)await p.createClient('page-'+i,20,100);
 const first=await p.listClients();assert.equal(first.clients.length,100);assert.ok(first.next_cursor);
 const second=await p.listClients(first.next_cursor);assert.equal(second.clients.length,1);assert.equal(second.next_cursor,null);
 assert.equal(await p.revokeClient(c.client_id),true);assert.equal(await p.authenticate(c.token),null);assert.equal((await p.updateClient(c.client_id,'x',20,100)).status,409);
 assert.equal(JSON.stringify(await p.listClients()).includes(c.token),false);
});
