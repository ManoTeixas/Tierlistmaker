// Contas (e-mail + senha) e sincronização das listas. Sem dependências: usa só o Node.
// Dados em DATA_DIR (padrão ./data):  users.json  e  blobs/<id>.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BLOBS = path.join(DATA_DIR, 'blobs');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 12 * 1024 * 1024;   // listas + fotos de um usuário
const MODES = ['jogos', 'futebol', 'tier', 'bracket'];
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

fs.mkdirSync(BLOBS, { recursive: true });

// ---------- armazenamento (arquivo JSON, gravação atômica e em fila) ----------
let db = { users: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))); } catch (_) { /* primeiro uso */ }
const byEmail = new Map(Object.values(db.users).map((u) => [u.email, u.id]));

let queue = Promise.resolve();
function writeAtomic(file, text) {
  queue = queue.then(async () => {
    const tmp = file + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, text, { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }).catch((e) => console.error('Erro ao gravar', file, e.message));
  return queue;
}
const saveDb = () => writeAtomic(USERS_FILE, JSON.stringify(db));
const blobFile = (uid) => path.join(BLOBS, uid + '.json');
function readBlob(uid) {
  try { return JSON.parse(fs.readFileSync(blobFile(uid), 'utf8')); } catch (_) { return { rev: 0, projects: [], lib: {}, deleted: {} }; }
}

// ---------- utilidades ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(body));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('Formato inválido.'), { code: 415 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(Object.assign(new Error('Dados grandes demais. Exclua algumas fotos.'), { code: 413 })); }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(Object.assign(new Error('JSON inválido.'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') || process.env.COOKIE_SECURE === '1';
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
function cookieOf(req, name) {
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return '';
}
const setCookie = (req, token, maxAge) => `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// limite de tentativas em memória: chave -> [instantes]
const hits = new Map();
function tooMany(key, max, windowMs, add) {
  const now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (add) arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 3600e3)) hits.delete(k); for (const [h, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[h]; }, 10 * 60 * 1000).unref();

// ---------- senha ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return salt.toString('hex') + ':' + key.toString('hex');
}
const DUMMY = hashPassword('senha-falsa-para-igualar-o-tempo');
async function checkPassword(pw, stored) {
  const [s, k] = String(stored || '').split(':');
  if (!s || !k) { await scrypt(pw, Buffer.alloc(16), 64); return false; }
  const key = await scrypt(pw, Buffer.from(s, 'hex'), 64), want = Buffer.from(k, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// ---------- sessão ----------
function sessionUser(req) {
  const tok = cookieOf(req, 'sid');
  if (!tok) return null;
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.uid] || null;
}
function startSession(req, res, uid, body) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { uid, exp: Date.now() + SESSION_MS };
  saveDb();
  send(res, 200, body, { 'Set-Cookie': setCookie(req, token, SESSION_MS / 1000) });
}

// ---------- validação dos dados sincronizados ----------
function cleanSync(b) {
  if (!b || typeof b !== 'object') throw new Error('Dados inválidos.');
  const projects = Array.isArray(b.projects) ? b.projects : null;
  if (!projects || projects.length > 500) throw new Error('Listas inválidas.');
  for (const p of projects) {
    if (!p || typeof p.id !== 'string' || p.id.length > 64 || !MODES.includes(p.mode) || typeof p.updated !== 'number' || typeof p.data !== 'object' || !p.data) throw new Error('Lista inválida.');
  }
  const lib = b.lib && typeof b.lib === 'object' && !Array.isArray(b.lib) ? b.lib : {};
  const deleted = {};
  if (b.deleted && typeof b.deleted === 'object') {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(b.deleted)) if (typeof v === 'number' && v > cutoff && k.length <= 80) deleted[k] = v;
  }
  return { projects, lib, deleted };
}

function originOk(req) {   // a origem tem de ser este mesmo site
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (_) { return false; }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

// Retorna true se tratou a requisição.
async function handle(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/auth/') && p !== '/api/sync') return false;
  try {
    if (req.method !== 'GET' && !originOk(req)) return send(res, 403, { error: 'Origem não permitida.' }), true;   // proteção contra CSRF

    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = sessionUser(req);
      return send(res, 200, { user: u ? { email: u.email } : null }), true;
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const tok = cookieOf(req, 'sid');
      if (tok) { delete db.sessions[sha(tok)]; saveDb(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) }), true;
    }

    if ((p === '/api/auth/register' || p === '/api/auth/login') && req.method === 'POST') {
      const b = await readJson(req, 10 * 1024);
      const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
      const ip = clientIp(req);
      if (p.endsWith('register')) {
        if (tooMany('reg:' + ip, 10, 3600e3, true)) return send(res, 429, { error: 'Muitas contas criadas deste lugar. Tente mais tarde.' }), true;
        if (email.length > 254 || !EMAIL_RE.test(email)) return send(res, 400, { error: 'Digite um e-mail válido.' }), true;
        if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'A senha precisa ter de 8 a 200 caracteres.' }), true;
        if (byEmail.has(email)) return send(res, 409, { error: 'Já existe uma conta com este e-mail. Use “Entrar”.' }), true;
        const id = crypto.randomBytes(12).toString('hex');
        db.users[id] = { id, email, pass: await hashPassword(pw), created: Date.now() };
        byEmail.set(email, id);
        return startSession(req, res, id, { user: { email } }), true;
      }
      const key = 'login:' + ip + ':' + email;
      if (tooMany(key, 8, 15 * 60e3, false)) return send(res, 429, { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.' }), true;
      const uid = byEmail.get(email), u = uid && db.users[uid];
      const ok = await checkPassword(pw, u ? u.pass : (await DUMMY));
      if (!u || !ok) { tooMany(key, 8, 15 * 60e3, true); return send(res, 401, { error: 'E-mail ou senha incorretos.' }), true; }
      hits.delete(key);
      return startSession(req, res, u.id, { user: { email: u.email } }), true;
    }

    if (p === '/api/auth/delete' && req.method === 'POST') {
      const u = sessionUser(req);
      if (!u) return send(res, 401, { error: 'Entre na sua conta primeiro.' }), true;
      const b = await readJson(req, 10 * 1024);
      if (!(await checkPassword(String(b.password || ''), u.pass))) return send(res, 401, { error: 'Senha incorreta.' }), true;
      delete db.users[u.id]; byEmail.delete(u.email);
      for (const [h, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[h];
      saveDb(); fs.promises.rm(blobFile(u.id), { force: true }).catch(() => {});
      hooks.onDelete.forEach((fn) => { try { fn(u.id); } catch (_) {} });
      return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) }), true;
    }

    if (p === '/api/sync') {
      const u = sessionUser(req);
      if (!u) return send(res, 401, { error: 'Entre na sua conta.' }), true;
      if (req.method === 'GET') return send(res, 200, readBlob(u.id)), true;
      if (req.method === 'PUT') {
        const b = await readJson(req, MAX_BODY);
        const clean = cleanSync(b), cur = readBlob(u.id);
        if (Number(b.baseRev) !== cur.rev) return send(res, 409, cur), true;   // outro aparelho gravou antes: o cliente mescla e tenta de novo
        const next = { rev: cur.rev + 1, ...clean };
        await writeAtomic(blobFile(u.id), JSON.stringify(next));
        return send(res, 200, { rev: next.rev }), true;
      }
    }
    return send(res, 404, { error: 'Não encontrado.' }), true;
  } catch (e) {
    return send(res, e.code >= 400 && e.code < 500 ? e.code : 400, { error: e.message || 'Erro.' }), true;
  }
}

const hooks = { onDelete: [] };   // outros módulos (comunidade) apagam os dados de quem exclui a conta
module.exports = { handle, DATA_DIR, sessionUser, readJson, send, clientIp, tooMany, writeAtomic, originOk, hooks };