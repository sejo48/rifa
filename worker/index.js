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
async function adminIdentity(request, env) {
  const userId = request.headers.get('oai-authenticated-user-id');
  if (!userId) return false;
  let admin = await env.DB.prepare('SELECT user_id FROM administrators WHERE id = 1').first();
  // Bootstrap only the configured account, then authorize using its stable Site user ID.
  if (!admin && env.ADMIN_EMAIL && request.headers.get('oai-authenticated-user-email')?.toLowerCase() === env.ADMIN_EMAIL.toLowerCase().trim()) {
    await env.DB.prepare('INSERT INTO administrators (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING').bind(userId).run();
    admin = await env.DB.prepare('SELECT user_id FROM administrators WHERE id = 1').first();
  }
  return admin?.user_id === userId;
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
      if (url.pathname === '/api/session' && request.method === 'GET') return json({isAdmin:await adminIdentity(request,env), signedIn:!!request.headers.get('oai-authenticated-user-id')});
      if (url.pathname === '/api/state' && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403,'Origen no permitido.');
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415,'Formato no permitido.');
        if (!await adminIdentity(request,env)) throw new HttpError(403,'Solo el administrador puede modificar los sorteos.');
        if (Number(request.headers.get('Content-Length') || 0)>65536) throw new HttpError(413,'Archivo demasiado grande.');
        const text = await request.text();
        if (new TextEncoder().encode(text).length>65536) throw new HttpError(413,'Archivo demasiado grande.');
        let body; try {body=JSON.parse(text);} catch {throw new HttpError(400,'JSON no válido.');}
        return json(await mutate(env,body));
      }
      return json({error:'Ruta o método no permitido.'},404);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Lottery request failed:', error.message);
      return json({error:error instanceof HttpError ? error.message : 'No se pudo completar la operación. Inténtalo de nuevo.'},error instanceof HttpError ? error.status : 500);
    }
  }
};
