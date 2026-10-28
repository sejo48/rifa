const HTML = "__PAGE_HTML__";
const DRAWS = ['draw1', 'draw2'];
const VALID_STATUS = ['reserved', 'cancelled'];
const emptyState = () => ({draw1:{revision:null, entries:{}}, draw2:{revision:null, entries:{}}});
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{
  'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff'
}});
const COOKIE = '__Host-rifa_admin';
const SESSION_SECONDS = 12 * 60 * 60;
const hex = bytes => Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,'0')).join('');
const digest = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
function sessionToken(request) {
  const token = request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
async function adminIdentity(request, env) {
  if (!env.ADMIN_PASSWORD_HASH) return false;
  const token = sessionToken(request);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT auth_version FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Math.floor(Date.now()/1000)).first();
  return row?.auth_version === await digest(env.ADMIN_PASSWORD_HASH);
}
function requireOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403,'Origen no permitido.');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415,'Formato no permitido.');
}
async function requestJson(request, limit=65536) {
  if (Number(request.headers.get('Content-Length') || 0)>limit) throw new HttpError(413,'Archivo demasiado grande.');
  const text = await request.text();
  if (new TextEncoder().encode(text).length>limit) throw new HttpError(413,'Archivo demasiado grande.');
  try {return JSON.parse(text);} catch {throw new HttpError(400,'JSON no válido.');}
}
async function login(request, env) {
  requireOrigin(request);
  if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH || '')) throw new HttpError(503,'El acceso de administración no está configurado.');
  const body = await requestJson(request,1024);
  if (typeof body?.password !== 'string' || body.password.length>128) throw new HttpError(400,'Escribe la clave de administración.');
  const now = Math.floor(Date.now()/1000);
  const key = await digest((request.headers.get('CF-Connecting-IP') || 'unknown')+':'+env.ADMIN_PASSWORD_HASH);
  const attempt = await env.DB.prepare(`INSERT INTO login_attempts (id, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      attempts = CASE WHEN login_attempts.window_start <= ? THEN 1 ELSE login_attempts.attempts + 1 END,
      window_start = CASE WHEN login_attempts.window_start <= ? THEN excluded.window_start ELSE login_attempts.window_start END
    RETURNING attempts`).bind(key,now,now-900,now-900).first();
  if (attempt.attempts>5) throw new HttpError(429,'Demasiados intentos. Espera 15 minutos antes de volver a entrar.');
  const [salt, expected] = env.ADMIN_PASSWORD_HASH.split(':');
  const material = await crypto.subtle.importKey('raw',new TextEncoder().encode(body.password),'PBKDF2',false,['deriveBits']);
  const actual = hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:Uint8Array.from(salt.match(/../g),v=>parseInt(v,16)),iterations:100000,hash:'SHA-256'},material,256));
  let difference=0;
  for(let i=0;i<expected.length;i++) difference |= expected.charCodeAt(i)^actual.charCodeAt(i);
  if (difference) throw new HttpError(401,'Clave incorrecta.');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM login_attempts WHERE window_start <= ? OR id = ?').bind(now-900,key).run();
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, expires_at, auth_version) VALUES (?, ?, ?)').bind(await digest(token),now+SESSION_SECONDS,await digest(env.ADMIN_PASSWORD_HASH)).run();
  const response = json({isAdmin:true});
  response.headers.set('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
  return response;
}
async function logout(request, env) {
  requireOrigin(request);
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await digest(token)).run();
  const response = json({isAdmin:false});
  response.headers.set('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return response;
}

async function readState(env) {
  const row = await env.DB.prepare('SELECT data, revision FROM app_state WHERE id = ?').bind('lottery').first();
  return {state:row ? JSON.parse(row.data) : emptyState(), revision:row?.revision ?? null};
}
async function commit(env, state, expectedRevision) {
  const revision = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO app_state (id, data, revision) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, revision = excluded.revision
    WHERE app_state.revision = ?`).bind('lottery', JSON.stringify(state), revision, expectedRevision).run();
  return result.meta.changes === 1;
}
function checkDraw(draw) { if (!DRAWS.includes(draw)) throw new HttpError(400, 'Sorteo no válido.'); }
function checkNumber(number) { if (!Number.isInteger(number) || number < 0 || number > 99) throw new HttpError(400, 'Número no válido.'); }
function checkVersion(version) { if (version !== null && (typeof version !== 'string' || !/^[\da-f-]{36}$/i.test(version))) throw new HttpError(400, 'Versión no válida.'); }
function checkEntry(entry) {
  if (typeof entry?.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 100 || !VALID_STATUS.includes(entry.status)) {
    throw new HttpError(400, 'Escribe un nombre de hasta 100 caracteres y un estado válido.');
  }
  return {name:entry.name.trim(), status:entry.status};
}
function validateMutation(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Solicitud no válida.');
  if (['save','delete'].includes(body.action)) {
    checkDraw(body.draw); checkNumber(body.number); checkVersion(body.expectedVersion);
    if (body.action === 'save') body.entry = checkEntry(body.entry);
  } else if (body.action === 'reset') {
    if (body.draw !== 'all') checkDraw(body.draw);
    for (const draw of body.draw === 'all' ? DRAWS : [body.draw]) checkVersion(body.expectedRevisions?.[draw]);
  } else if (body.action === 'import') {
    if (!body.draws || typeof body.draws !== 'object' || Object.keys(body.draws).some(d=>!DRAWS.includes(d))) throw new HttpError(400, 'Archivo de respaldo no válido.');
    for (const [draw, entries] of Object.entries(body.draws)) {
      checkDraw(draw);
      if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 100) throw new HttpError(400, 'Respaldo no válido.');
      for (const [number, entry] of Object.entries(entries)) {
        if (!/^(0|[1-9][0-9]?)$/.test(number)) throw new HttpError(400, 'Número de respaldo no válido.');
        entries[number] = checkEntry(entry);
      }
    }
  } else throw new HttpError(400, 'Operación no válida.');
}
async function mutate(env, body) {
  validateMutation(body);
  for (let attempt=0; attempt<8; attempt++) {
    const {state, revision} = await readState(env);
    let imported = 0;
    if (body.action === 'save' || body.action === 'delete') {
      const draw = state[body.draw];
      const current = draw.entries[body.number];
      if ((current?.version ?? null) !== body.expectedVersion) throw new HttpError(409, 'Este número cambió desde que lo abriste. Cierra y vuelve a abrirlo para revisar los datos actuales.');
      draw.entries[body.number] = {...(body.action === 'save' ? body.entry : {name:null, status:null}), version:crypto.randomUUID()};
      draw.revision = crypto.randomUUID();
    } else if (body.action === 'reset') {
      for (const id of body.draw === 'all' ? DRAWS : [body.draw]) {
        if (state[id].revision !== body.expectedRevisions[id]) throw new HttpError(409, 'Hay cambios nuevos. Revisa los sorteos antes de confirmar el borrado.');
        // Tombstones prevent an editor opened before the reset from restoring stale data.
        state[id] = {revision:crypto.randomUUID(),entries:Object.fromEntries(Array.from({length:100},(_,n)=>[n,{name:null,status:null,version:crypto.randomUUID()}]))};
      }
    } else {
      for (const [id, entries] of Object.entries(body.draws)) {
        for (const [number, entry] of Object.entries(entries)) {
          // Imports never overwrite a sale already recorded on the web.
          if (state[id].entries[number]?.name) continue;
          state[id].entries[number] = {...entry,version:crypto.randomUUID()};
          state[id].revision = crypto.randomUUID();
          imported++;
        }
      }
    }
    if (await commit(env,state,revision)) return {draws:state, imported};
  }
  throw new HttpError(409, 'Otros cambios se están guardando. Inténtalo de nuevo.');
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/' && ['GET','HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : HTML, {headers:{
        'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache',
        'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin'
      }});
      if (!url.pathname.startsWith('/api/')) return json({error:'Página no encontrada.'},404);
      if (!env.DB) throw new HttpError(503,'El almacenamiento compartido todavía no está disponible.');
      if (url.pathname === '/api/state' && request.method === 'GET') return json({draws:(await readState(env)).state});
      if (url.pathname === '/api/session' && request.method === 'GET') return json({isAdmin:await adminIdentity(request,env)});
      if (url.pathname === '/api/login' && request.method === 'POST') return await login(request,env);
      if (url.pathname === '/api/logout' && request.method === 'POST') return await logout(request,env);
      if (url.pathname === '/api/state' && request.method === 'POST') {
        requireOrigin(request);
        if (!await adminIdentity(request,env)) throw new HttpError(403,'Solo el administrador puede modificar los sorteos.');
        const body = await requestJson(request);
        return json(await mutate(env,body));
      }
      return json({error:'Ruta o método no permitido.'},404);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Lottery request failed:', error.message);
      return json({error:error instanceof HttpError ? error.message : 'No se pudo completar la operación. Inténtalo de nuevo.'},error instanceof HttpError ? error.status : 500);
    }
  }
};
