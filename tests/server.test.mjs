import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';
import {pbkdf2Sync, createHash} from 'node:crypto';
const ORIGIN='https://rifa.example';
const fixturePassword='test-only-password';
const salt='ab'.repeat(16);
const hash=salt+':'+pbkdf2Sync(fixturePassword,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');
const digest=text=>createHash('sha256').update(text).digest('hex');
const fixtureToken='cd'.repeat(32);
const owner={Cookie:'__Host-rifa_admin='+fixtureToken};
function setup() {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../drizzle/0000_shared_lottery.sql',import.meta.url),'utf8').replace('--> statement-breakpoint',''));
 sqlite.exec(readFileSync(new URL('../drizzle/0001_password_sessions.sql',import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
 sqlite.prepare('INSERT INTO admin_sessions (token_hash, expires_at, auth_version) VALUES (?, ?, ?)').run(digest(fixtureToken),Math.floor(Date.now()/1000)+3600,digest(hash));
 const DB={prepare(sql){let args=[];return {bind(...a){args=a;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}};
 const env={DB,ADMIN_PASSWORD_HASH:hash};
 async function call(path='/api/state',body,identity=owner,headers={}) {
  const req=new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...identity,...(body===undefined?{}:{Origin:ORIGIN,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const response=await worker.fetch(req,env);
  return {status:response.status,body:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0],headers:response.headers};
 }
 return {call,env,sqlite};
}
const sale=(number,name,expectedVersion=null,draw='draw1')=>({action:'save',draw,number,expectedVersion,entry:{name,status:'reserved'}});
test('anonymous visitors read shared state but cannot write or reset',async()=>{
 const {call}=setup();
 assert.equal((await call('/api/state',undefined,{})).status,200);
 for(const body of [sale(1,'Alice'),{action:'delete',draw:'draw1',number:1,expectedVersion:null},{action:'reset',draw:'all',expectedRevisions:{draw1:null,draw2:null}}]) assert.equal((await call('/api/state',body,{})).status,403);
});
test('only a valid password creates an administrator session, logout revokes it',async()=>{
 const {call}=setup();
 assert.equal((await call('/api/session',undefined,{})).body.isAdmin,false);
 assert.equal((await call('/api/session',undefined,{'oai-authenticated-user-id':'site-owner','oai-authenticated-user-email':'owner@example.com'})).body.isAdmin,false);
 assert.equal((await call('/api/login',{password:'incorrect'},{})).status,401);
 const logged=await call('/api/login',{password:fixturePassword},{});
 assert.equal(logged.status,200);assert.ok(logged.cookie);
 assert.match(logged.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
 const session={Cookie:logged.cookie};
 assert.equal((await call('/api/session',undefined,session)).body.isAdmin,true);
 assert.equal((await call('/api/state',sale(1,'Allowed'),session)).status,200);
 assert.equal((await call('/api/logout',{},session)).status,200);
 assert.equal((await call('/api/session',undefined,session)).body.isAdmin,false);
 assert.equal((await call('/api/state',sale(2,'Denied'),session)).status,403);
});
test('five password failures lock out further attempts for the window',async()=>{
 const {call,sqlite}=setup();
 for(let i=0;i<5;i++) assert.equal((await call('/api/login',{password:'incorrect'},{})).status,401);
 assert.equal((await call('/api/login',{password:fixturePassword},{})).status,429);
 sqlite.prepare('UPDATE login_attempts SET window_start = ?').run(Math.floor(Date.now()/1000)-901);
 assert.equal((await call('/api/login',{password:fixturePassword},{})).status,200);
});
test('expired, forged and rotated sessions fail closed',async()=>{
 const {call,env,sqlite}=setup();
 assert.equal((await call('/api/session',undefined,{Cookie:'__Host-rifa_admin=forged'})).body.isAdmin,false);
 sqlite.prepare('UPDATE admin_sessions SET expires_at = 0').run();
 assert.equal((await call('/api/session')).body.isAdmin,false);
 sqlite.prepare('UPDATE admin_sessions SET expires_at = ?').run(Math.floor(Date.now()/1000)+1000);
 env.ADMIN_PASSWORD_HASH='ff'.repeat(16)+':'+hash.split(':')[1];
 assert.equal((await call('/api/session')).body.isAdmin,false);
 delete env.ADMIN_PASSWORD_HASH;
 assert.equal((await call('/api/login',{password:fixturePassword},{})).status,503);
});
test('login and logout reject cross-origin requests',async()=>{
 const {call}=setup();
 assert.equal((await call('/api/login',{password:fixturePassword},{},{Origin:'https://evil.example'})).status,403);
 assert.equal((await call('/api/logout',{},owner,{Origin:'https://evil.example'})).status,403);
});
test('independent simultaneous edits merge instead of losing a sale',async()=>{
 const {call}=setup();await call('/api/session');
 const outcomes=await Promise.all([call('/api/state',sale(1,'Alice')),call('/api/state',sale(2,'Bob')),call('/api/state',sale(3,'Carol',null,'draw2'))]);
 assert.deepEqual(outcomes.map(r=>r.status),[200,200,200]);
 const {draws}= (await call()).body;
 assert.equal(draws.draw1.entries[1].name,'Alice');assert.equal(draws.draw1.entries[2].name,'Bob');assert.equal(draws.draw2.entries[3].name,'Carol');
});
test('simultaneous edits to the same ticket conflict',async()=>{
 const {call}=setup();await call('/api/session');
 const r=await Promise.all([call('/api/state',sale(1,'Alice')),call('/api/state',sale(1,'Bob'))]);
 assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
});
test('another visitor and a fresh Worker see persisted data',async()=>{
 const {call,env}=setup();await call('/api/state',sale(10,'Persisted'));
 const response=await worker.fetch(new Request(ORIGIN+'/api/state'),{...env});
 assert.equal((await response.json()).draws.draw1.entries[10].name,'Persisted');
});
test('reset checks snapshot and preserves unrelated draw',async()=>{
 const {call}=setup();
 const old=(await call()).body.draws;
 await call('/api/state',sale(1,'New sale'));
 assert.equal((await call('/api/state',{action:'reset',draw:'draw1',expectedRevisions:{draw1:old.draw1.revision}})).status,409);
 await call('/api/state',sale(5,'Keep me',null,'draw2'));
 const before=(await call()).body.draws;
 const r=await call('/api/state',{action:'reset',draw:'draw1',expectedRevisions:{draw1:before.draw1.revision}});
 assert.equal(r.status,200);assert.equal(r.body.draws.draw1.entries[1].name,null);assert.equal(r.body.draws.draw2.entries[5].name,'Keep me');
 assert.equal((await call('/api/state',sale(1,'Stale',before.draw1.entries[1].version))).status,409);
 assert.equal((await call('/api/state',sale(50,'Stale empty'))).status,409);
});
test('release retains a version and prevents stale overwrite',async()=>{
 const {call}=setup();const r=await call('/api/state',sale(9,'Alice'));
 const version=r.body.draws.draw1.entries[9].version;
 const del=await call('/api/state',{action:'delete',draw:'draw1',number:9,expectedVersion:version});
 assert.equal(del.status,200);assert.equal(del.body.draws.draw1.entries[9].name,null);
 assert.equal((await call('/api/state',sale(9,'Stale',version))).status,409);
 assert.equal((await call('/api/state',sale(9,'New',del.body.draws.draw1.entries[9].version))).status,200);
});
test('full reset requires both current draw snapshots',async()=>{
 const {call}=setup();await call('/api/state',sale(1,'A'));await call('/api/state',sale(1,'B',null,'draw2'));
 const state=(await call()).body.draws;
 const r=await call('/api/state',{action:'reset',draw:'all',expectedRevisions:{draw1:state.draw1.revision,draw2:state.draw2.revision}});
 assert.equal(r.status,200);assert.equal(r.body.draws.draw1.entries[1].name,null);assert.equal(r.body.draws.draw2.entries[1].name,null);
});
test('imports validate and never replace existing sales',async()=>{
 const {call}=setup();await call('/api/state',sale(1,'Existing'));
 const r=await call('/api/state',{action:'import',draws:{draw1:{1:{name:'Overwrite',status:'cancelled'},2:{name:'Imported',status:'reserved'}}}});
 assert.equal(r.status,200);assert.equal(r.body.imported,1);assert.equal(r.body.draws.draw1.entries[1].name,'Existing');assert.equal(r.body.draws.draw1.entries[2].name,'Imported');
 const bad=await call('/api/state',{action:'import',draws:{draw1:{101:{name:'Invalid',status:'reserved'}}}});
 assert.equal(bad.status,400);
});
test('invalid input, cross-origin writes and oversized bodies are rejected',async()=>{
 const {call}=setup();
 for(const bad of [sale(-1,'A'),sale(100,'A'),sale(1,''),sale(1,'x'.repeat(101)),{...sale(1,'A'),draw:'other'},{...sale(1,'A'),entry:{name:'A',status:'invalid'}}]) assert.equal((await call('/api/state',bad)).status,400);
 assert.equal((await call('/api/state',sale(1,'A'),owner,{Origin:'https://evil.example'})).status,403);
 assert.equal((await call('/api/state',sale(1,'A'),owner,{'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await call('/api/state',sale(1,'A'),owner,{'Content-Type':'text/plain'})).status,415);
 assert.equal((await call('/api/state',sale(1,'A'),owner,{'Content-Length':'70000'})).status,413);
});
test('buyer markup is stored as data; frontend summaries use textContent',async()=>{
 const {call}=setup();const payload='<img src=x onerror="alert(1)">';
 const r=await call('/api/state',sale(1,payload));assert.equal(r.status,200);assert.equal(r.body.draws.draw1.entries[1].name,payload);
 const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
 assert.ok(html.includes('label.textContent=name'));
 assert.ok(!html.includes('.innerHTML'));assert.ok(!html.includes('localStorage.clear'));
 assert.ok(!html.includes(fixturePassword));
});
