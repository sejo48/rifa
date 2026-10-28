import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function element(){
 const classes=new Set();
 return {children:[],value:'',disabled:false,textContent:'',className:'',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){const value=on ?? !classes.has(x);value?classes.add(x):classes.delete(x);return value;}},setAttribute(){},append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},replaceChildren(){this.children=[];},querySelector(){return null;},focus(){},click(){}};
}
async function client({admin=true,offline=false}={}){
 const nodes=new Map(),storage=new Map([['other-app','keep']]);
 const state={draw1:{revision:null,entries:{}},draw2:{revision:null,entries:{}}};
 const writes=[];
 const document={hidden:false,activeElement:null,getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element,querySelectorAll(){return [];},addEventListener(){}};
 const ctx={document,AbortSignal,Date,Map,Object,String,JSON,console,URL,Blob,setInterval(){},setTimeout(){},localStorage:{setItem:(k,v)=>storage.set(k,v)},fetch:async(path,opts)=>{
  if(offline) throw new TypeError('offline');
  if(path==='/api/session') return Response.json({isAdmin:admin});
  if(path==='/api/login') return opts.body && JSON.parse(opts.body).password==='test-only-password' ? Response.json({isAdmin:true}) : Response.json({error:'Clave incorrecta.'},{status:401});
  if(path==='/api/logout') return Response.json({isAdmin:false});
  if(opts.method==='POST') {const body=JSON.parse(opts.body);writes.push(body);state[body.draw].entries[body.number]={...body.entry,version:'new-version'};}
  return Response.json({draws:structuredClone(state)});
 }};ctx.window=ctx;ctx.addEventListener=()=>{};
 vm.createContext(ctx);vm.runInContext(script,ctx);await tick();await tick();
 return {ctx,nodes,storage,state,writes};
}
test('client loads state, safely renders buyer names and writes selected snapshot',async()=>{
 const {ctx,nodes,state,writes}=await client();
 const payload='<img src=x onerror="alert(1)">';
 state.draw1.entries[1]={name:payload,status:'reserved',version:'original-version'};
 await ctx.refresh();
 const label=nodes.get('summary-list').children[0].children[0];
 assert.equal(label.textContent,payload);assert.equal(label.children.length,0);
 ctx.openEditModal(1);
 // A background update must not alter the selected edit version or input.
 state.draw1.entries[1]={name:'Other edit',status:'cancelled',version:'changed-version'};
 await ctx.refresh();
 assert.equal(nodes.get('input-name').value,payload);
 nodes.get('input-name').value='Updated';nodes.get('input-status').value='reserved';
 await ctx.saveData();
 assert.equal(writes[0].expectedVersion,'original-version');
 assert.equal(writes[0].entry.name,'Updated');
});
test('observer cannot invoke saveData to submit a write',async()=>{
 const {ctx,nodes,writes}=await client({admin:false});
 ctx.openEditModal(1);ctx.document.getElementById('input-name').value='Unauthorized';
 await ctx.saveData();assert.equal(writes.length,0);
});
test('offline client blocks writes and preserves unrelated local storage',async()=>{
 const {ctx,nodes,writes,storage}=await client({offline:true});
 ctx.openEditModal(1);ctx.document.getElementById('input-name').value='Offline';
 await ctx.saveData();await ctx.factoryReset();
 assert.equal(writes.length,0);assert.equal(storage.get('other-app'),'keep');
 assert.ok(nodes.get('sync-status').textContent.includes('Sin conexión'));
});

test('password modal logs in and logs out without ChatGPT',async()=>{
 const {ctx,nodes}=await client({admin:false});
 ctx.document.getElementById('admin-password-input').value='test-only-password';
 await ctx.loginAdmin();
 assert.equal(nodes.get('role-badge').textContent,'Administrador');
 assert.equal(nodes.get('admin-password-input').value,'');
 await ctx.logoutAdmin();
 assert.equal(nodes.get('role-badge').textContent,'Modo Observador');
});
test('incorrect password leaves the visitor in observer mode',async()=>{
 const {ctx,nodes}=await client({admin:false});
 ctx.document.getElementById('admin-password-input').value='wrong';
 await ctx.loginAdmin();
 assert.equal(nodes.get('role-badge').textContent,'Modo Observador');
 assert.equal(nodes.get('message').textContent,'Clave incorrecta.');
 assert.equal(nodes.get('admin-password-input').value,'');
});
