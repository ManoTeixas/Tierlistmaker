// Comunidade: tierlists publicadas por quem está logado. Dados em DATA_DIR/community.json (índice)
// e DATA_DIR/posts/<id>.json (conteúdo + fotos). Tudo que chega é revalidado e reescrito aqui.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

const INDEX = path.join(auth.DATA_DIR, 'community.json');
const POSTS = path.join(auth.DATA_DIR, 'posts');
fs.mkdirSync(POSTS, { recursive: true });

const MAX_BODY = 6 * 1024 * 1024, MAX_PHOTOS = 3.5 * 1024 * 1024, MAX_PER_PHOTO = 700 * 1024;
const MAX_POSTS_PER_USER = 30, REPORTS_TO_HIDE = 3;
const ADMIN = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const HEX = /^#[0-9a-f]{6}$/i, ID = /^[0-9a-f]{16}$/;
const IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

let index = { posts: {} };
try { index = Object.assign(index, JSON.parse(fs.readFileSync(INDEX, 'utf8'))); } catch (_) { /* primeiro uso */ }
const saveIndex = () => auth.writeAtomic(INDEX, JSON.stringify(index));
const postFile = (id) => path.join(POSTS, id + '.json');

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const bad = (msg, code) => Object.assign(new Error(msg), { code: code || 400 });

// Reescreve a tierlist só com campos conhecidos. Fotos entram apenas se forem imagens em base64.
function cleanTier(data, lib) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tiers) || !Array.isArray(data.pool)) throw bad('Tierlist inválida.');
  lib = lib && typeof lib === 'object' ? lib : {};
  const title = str(data.title, 60);
  if (!title) throw bad('Dê um nome à tierlist antes de publicar.');
  if (data.tiers.length < 1 || data.tiers.length > 12) throw bad('A tierlist precisa ter de 1 a 12 tiers.');
  const photos = {}; let photoBytes = 0, total = 0;
  const item = (g) => {
    if (!g || typeof g !== 'object') return null;
    const name = str(g.name, 60); if (!name) return null;
    if (++total > 300) throw bad('Muitos itens (máximo 300).');
    const id = str(g.id, 64) || crypto.randomBytes(6).toString('hex');
    if (g.u) {
      const l = lib[g.id];
      if (l && typeof l.src === 'string' && l.src.length <= MAX_PER_PHOTO && IMG.test(l.src)) {
        if (!photos[id]) { photoBytes += l.src.length; photos[id] = { name: str(l.name, 60) || name, src: l.src, credit: str(l.credit, 120) }; }
        return { id, name, u: 1 };
      }
      return { id, name, x: 1 };   // foto sem arquivo válido vira item de texto
    }
    const out = { id, name, x: 1 };
    if (typeof g.c === 'string' && HEX.test(g.c)) out.c = g.c;
    return out;
  };
  const items = (a) => (Array.isArray(a) ? a.slice(0, 300).map(item).filter(Boolean) : []);
  const tiers = data.tiers.map((t, i) => ({
    id: str(t && t.id, 40) || 't' + i, name: str(t && t.name, 40),
    color: t && HEX.test(t.color) ? t.color : '#888888', items: items(t && t.items),
  }));
  const pool = items(data.pool);
  if (!total) throw bad('Coloque pelo menos um item na tierlist antes de publicar.');
  if (photoBytes > MAX_PHOTOS) throw bad('As fotos da tierlist são grandes demais para publicar. Use menos fotos.', 413);
  return { data: { title, names: !!data.names, pool, tiers }, photos, total };
}

const meta = (m, uid) => ({ id: m.id, title: m.title, author: m.author, created: m.created, updated: m.updated, n: m.n, tiers: m.tiers, sample: m.sample, mine: !!uid && m.uid === uid });

async function handle(req, res, url) {
  const p = url.pathname;
  if (p !== '/api/community' && !p.startsWith('/api/community/')) return false;
  const send = auth.send;
  try {
    if (req.method !== 'GET' && !auth.originOk(req)) return send(res, 403, { error: 'Origem não permitida.' }), true;
    const user = auth.sessionUser(req), uid = user && user.id;
    const parts = p.split('/').filter(Boolean);   // ['api','community', id?, 'report'?]

    if (parts.length === 2 && req.method === 'GET') {
      const list = Object.values(index.posts)
        .filter((m) => !m.hidden || m.uid === uid)
        .sort((a, b) => b.updated - a.updated).slice(0, 100)
        .map((m) => meta(m, uid));
      return send(res, 200, { posts: list }), true;
    }

    if (parts.length === 2 && req.method === 'POST') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta para publicar.' }), true;
      if (auth.tooMany('pub:' + uid, 10, 3600e3, true)) return send(res, 429, { error: 'Muitas publicações seguidas. Tente de novo mais tarde.' }), true;
      const b = await auth.readJson(req, MAX_BODY);
      const author = str(b.author, 24);
      if (author.length < 2) return send(res, 400, { error: 'Escolha um nome de 2 a 24 letras para aparecer na comunidade.' }), true;
      const pid = str(b.pid, 64);
      if (!pid) return send(res, 400, { error: 'Lista inválida.' }), true;
      const { data, photos, total } = cleanTier(b.data, b.lib);
      let m = Object.values(index.posts).find((x) => x.uid === uid && x.pid === pid);
      if (!m) {
        if (Object.values(index.posts).filter((x) => x.uid === uid).length >= MAX_POSTS_PER_USER) return send(res, 400, { error: `Limite de ${MAX_POSTS_PER_USER} publicações. Retire alguma para publicar outra.` }), true;
        m = { id: crypto.randomBytes(8).toString('hex'), uid, pid, created: Date.now(), reports: [], hidden: false };
        index.posts[m.id] = m;
      }
      const names = data.tiers.flatMap((t) => t.items).concat(data.pool).map((g) => g.name);
      Object.assign(m, { title: data.title, author, updated: Date.now(), n: total, sample: names.slice(0, 6), tiers: data.tiers.map((t) => ({ name: t.name, color: t.color })) });
      await auth.writeAtomic(postFile(m.id), JSON.stringify({ data, photos }));
      await saveIndex();
      return send(res, 200, { id: m.id }), true;
    }

    const id = parts[2], m = ID.test(id || '') && index.posts[id];
    if (!m) return send(res, 404, { error: 'Publicação não encontrada.' }), true;
    const canSee = !m.hidden || m.uid === uid;

    if (parts.length === 3 && req.method === 'GET') {
      if (!canSee) return send(res, 404, { error: 'Publicação não encontrada.' }), true;
      let body; try { body = JSON.parse(fs.readFileSync(postFile(id), 'utf8')); } catch (_) { return send(res, 404, { error: 'Publicação não encontrada.' }), true; }
      return send(res, 200, Object.assign(meta(m, uid), body)), true;
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta.' }), true;
      if (m.uid !== uid && !(ADMIN && user.email === ADMIN)) return send(res, 403, { error: 'Só quem publicou pode retirar.' }), true;
      removePost(id);
      return send(res, 200, { ok: true }), true;
    }
    if (parts.length === 4 && parts[3] === 'report' && req.method === 'POST') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta para denunciar.' }), true;
      if (m.uid === uid) return send(res, 400, { error: 'Você não pode denunciar a própria publicação.' }), true;
      if (!m.reports.includes(uid)) m.reports.push(uid);
      if (m.reports.length >= REPORTS_TO_HIDE) m.hidden = true;
      await saveIndex();
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 404, { error: 'Não encontrado.' }), true;
  } catch (e) {
    return send(res, e.code >= 400 && e.code < 500 ? e.code : 400, { error: e.message || 'Erro.' }), true;
  }
}

function removePost(id) {
  delete index.posts[id];
  fs.promises.rm(postFile(id), { force: true }).catch(() => {});
  saveIndex();
}
auth.hooks.onDelete.push((uid) => { for (const m of Object.values(index.posts)) if (m.uid === uid) removePost(m.id); });

module.exports = { handle };
