// Comunidade: tierlists publicadas por quem está logado. O índice (título, autor, categoria…) fica em
// memória; o conteúdo + fotos de cada publicação é lido do store (Postgres ou arquivos) quando alguém abre.
// Tudo que chega é revalidado e reescrito aqui.
const crypto = require('crypto');
const auth = require('./auth');
const store = require('./store');
const sources = require('./sources');

const MAX_BODY = 6 * 1024 * 1024, MAX_PHOTOS = 3.5 * 1024 * 1024, MAX_PER_PHOTO = 700 * 1024;
const MAX_POSTS_PER_USER = 30, REPORTS_TO_HIDE = 3;
const ADMIN = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const HEX = /^#[0-9a-f]{6}$/i, ID = /^[0-9a-f]{16}$/;
const IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const index = { posts: {} };
const ready = (async () => { for (const m of await store.allPosts()) index.posts[m.id] = m; })();

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const bad = (msg, code) => Object.assign(new Error(msg), { code: code || 400 });

// Reescreve itens só com campos conhecidos. Fotos entram apenas se forem imagens em base64.
// Usado pela comunidade e pelos links de compartilhamento (share.js).
function itemCleaner(lib) {
  lib = lib && typeof lib === 'object' ? lib : {};
  const st = { photos: {}, photoBytes: 0, total: 0 };
  st.item = (g) => {
    if (!g || typeof g !== 'object') return null;
    const name = str(g.name, 60); if (!name) return null;
    if (++st.total > 300) throw bad('Muitos itens (máximo 300).');
    const id = str(g.id, 64) || crypto.randomBytes(6).toString('hex');
    if (g.u) {
      const l = lib[g.id];
      if (l && typeof l.src === 'string' && l.src.length <= MAX_PER_PHOTO && IMG.test(l.src)) {
        if (!st.photos[id]) { st.photoBytes += l.src.length; st.photos[id] = { name: str(l.name, 60) || name, src: l.src, credit: str(l.credit, 120) }; }
        return { id, name, u: 1 };
      }
      return { id, name, x: 1 };   // foto sem arquivo válido vira item de texto
    }
    if (g.r !== undefined) return sources.validRef(g.r) ? Object.assign({ id, name, r: g.r }, sources.validPlay(g.p) ? { p: g.p } : {}) : { id, name, x: 1 };   // capa de uma fonte (Steam, filmes…)
    const out = { id, name, x: 1 };
    if (typeof g.c === 'string' && HEX.test(g.c)) out.c = g.c;
    if (typeof g.ico === 'string' && g.ico.length <= 16) out.ico = str(g.ico, 16);
    return out;
  };
  st.items = (a) => (Array.isArray(a) ? a.slice(0, 300).map(st.item).filter(Boolean) : []);
  st.checkPhotos = () => { if (st.photoBytes > MAX_PHOTOS) throw bad('As fotos da lista são grandes demais. Use menos fotos.', 413); };
  return st;
}

function cleanTier(data, lib) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tiers) || !Array.isArray(data.pool)) throw bad('Tierlist inválida.');
  const title = str(data.title, 60);
  if (!title) throw bad('Dê um nome à tierlist antes de publicar.');
  if (data.tiers.length < 1 || data.tiers.length > 12) throw bad('A tierlist precisa ter de 1 a 12 tiers.');
  const c = itemCleaner(lib);
  const tiers = data.tiers.map((t, i) => ({
    id: str(t && t.id, 40) || 't' + i, name: str(t && t.name, 40),
    color: t && HEX.test(t.color) ? t.color : '#888888', items: c.items(t && t.items),
  }));
  const pool = c.items(data.pool);
  if (!c.total) throw bad('Coloque pelo menos um item na tierlist antes de publicar.');
  c.checkPhotos();
  return { data: { title, names: !!data.names, pool, tiers }, photos: c.photos, total: c.total };
}

const fold = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const catOf = (m) => m.category || 'Outros';
// Se já existe uma categoria com o mesmo nome (sem diferenciar maiúsculas e acentos), reaproveita a grafia dela.
function canonCategory(name) {
  const f = fold(name);
  for (const m of Object.values(index.posts)) if (fold(catOf(m)) === f) return catOf(m);
  return name;
}
function categories(uid) {
  const n = new Map();
  for (const m of Object.values(index.posts)) if (!m.hidden || m.uid === uid) n.set(catOf(m), (n.get(catOf(m)) || 0) + 1);
  return [...n].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt'));
}
const meta = (m, uid) => ({ id: m.id, title: m.title, author: m.author, category: catOf(m), created: m.created, updated: m.updated, n: m.n, tiers: m.tiers, sample: m.sample, mine: !!uid && m.uid === uid });

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
      return send(res, 200, { posts: list, categories: categories(uid) }), true;
    }

    if (parts.length === 2 && req.method === 'POST') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta para publicar.' }), true;
      if (auth.tooMany('pub:' + uid, 10, 3600e3, true)) return send(res, 429, { error: 'Muitas publicações seguidas. Tente de novo mais tarde.' }), true;
      const b = await auth.readJson(req, MAX_BODY);
      const author = str(b.author, 24);
      if (author.length < 2) return send(res, 400, { error: 'Escolha um nome de 2 a 24 letras para aparecer na comunidade.' }), true;
      const category = canonCategory(str(b.category, 30).replace(/\s+/g, ' '));
      if (category.length < 2) return send(res, 400, { error: 'Escolha a categoria da tierlist (ex.: Filmes, Animes, Comida) ou crie uma nova.' }), true;
      const pid = str(b.pid, 64);
      if (!pid) return send(res, 400, { error: 'Lista inválida.' }), true;
      const { data, photos, total } = cleanTier(b.data, b.lib);
      const prev = Object.values(index.posts).find((x) => x.uid === uid && x.pid === pid);
      if (!prev && Object.values(index.posts).filter((x) => x.uid === uid).length >= MAX_POSTS_PER_USER) return send(res, 400, { error: `Limite de ${MAX_POSTS_PER_USER} publicações. Retire alguma para publicar outra.` }), true;
      const base = prev || { id: crypto.randomBytes(8).toString('hex'), uid, pid, created: Date.now(), reports: [], hidden: false };
      const names = data.tiers.flatMap((t) => t.items).concat(data.pool).map((g) => g.name);
      const m = { ...base, title: data.title, author, category, updated: Date.now(), n: total, sample: names.slice(0, 6), tiers: data.tiers.map((t) => ({ name: t.name, color: t.color })) };
      await store.putPost(m, { data, photos });
      index.posts[m.id] = m;
      return send(res, 200, { id: m.id }), true;
    }

    const id = parts[2], m = ID.test(id || '') && index.posts[id];
    if (!m) return send(res, 404, { error: 'Publicação não encontrada.' }), true;
    const canSee = !m.hidden || m.uid === uid;

    if (parts.length === 3 && req.method === 'GET') {
      if (!canSee) return send(res, 404, { error: 'Publicação não encontrada.' }), true;
      const body = await store.getPostBody(id);
      if (!body) return send(res, 404, { error: 'Publicação não encontrada.' }), true;
      return send(res, 200, Object.assign(meta(m, uid), body)), true;
    }
    if (parts.length === 3 && req.method === 'DELETE') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta.' }), true;
      if (m.uid !== uid && !(ADMIN && user.email === ADMIN)) return send(res, 403, { error: 'Só quem publicou pode retirar.' }), true;
      await store.delPost(id);
      delete index.posts[id];
      return send(res, 200, { ok: true }), true;
    }
    if (parts.length === 4 && parts[3] === 'report' && req.method === 'POST') {
      if (!user) return send(res, 401, { error: 'Entre na sua conta para denunciar.' }), true;
      if (m.uid === uid) return send(res, 400, { error: 'Você não pode denunciar a própria publicação.' }), true;
      if (!m.reports.includes(uid)) {
        const reports = [...m.reports, uid];
        const next = { ...m, reports, hidden: m.hidden || reports.length >= REPORTS_TO_HIDE };
        await store.putPostMeta(next);
        index.posts[id] = next;
      }
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 404, { error: 'Não encontrado.' }), true;
  } catch (e) {
    return auth.sendError(res, e), true;
  }
}

// Conta excluída: o store já apagou as publicações dela; aqui só limpa o índice em memória.
auth.hooks.onDelete.push((uid) => { for (const m of Object.values(index.posts)) if (m.uid === uid) delete index.posts[m.id]; });

module.exports = { handle, ready, itemCleaner, cleanTier, str, bad };