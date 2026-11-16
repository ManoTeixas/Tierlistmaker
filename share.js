// Links de compartilhamento: qualquer lista (tierlist, escalação, chaveamento) vira um link /s/<id>
// que mostra a imagem da lista e deixa quem abrir fazer a própria versão. Não precisa de conta:
// quem cria recebe um token secreto para atualizar ou desativar o mesmo link depois.
// Cada link guarda a lista + fotos e a imagem gerada no navegador, no store (Postgres ou arquivos).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const store = require('./store');
const { itemCleaner, str, bad } = require('./community');

const MAX_BODY = 9 * 1024 * 1024, MAX_IMAGE = 3 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{11}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const CATS = ['jogos', 'musica', 'filmes', 'series', 'animes', 'livros', 'futebol', 'comida', 'outros'];
const MODE_NAME = { tier: 'Tierlist', futebol: 'Escalação', bracket: 'Chaveamento' };
const PITCH_KEY = /^(f(10|[0-9])|c|b[0-6])$/;
const BR_SIZES = [4, 8, 16, 32, 64];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const num = (v, a, b) => (Number.isFinite(v) ? Math.min(b, Math.max(a, +v.toFixed(1))) : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Reescreve a lista de cada formato só com campos conhecidos.
function cleanList(mode, data, lib) {
  data = obj(data);
  const c = itemCleaner(lib);
  const title = str(data.title, 60) || 'Minha lista';
  let out;
  if (mode === 'tier') {
    if (!Array.isArray(data.tiers) || data.tiers.length < 1 || data.tiers.length > 12) throw bad('Tierlist inválida.');
    out = {
      title, names: !!data.names, pool: c.items(data.pool),
      tiers: data.tiers.map((t, i) => ({ id: str(t && t.id, 40) || 't' + i, name: str(t && t.name, 40), color: t && HEX.test(t.color) ? t.color : '#888888', items: c.items(t && t.items) })),
    };
  } else if (mode === 'futebol') {
    const formation = str(data.formation, 16), template = str(data.template, 24);
    if (!/^[a-z0-9]+$/i.test(formation) || !/^[a-z0-9_]+$/i.test(template)) throw bad('Escalação inválida.');
    const slots = {}, pos = {}, labels = {};
    for (const [k, g] of Object.entries(obj(data.slots))) if (PITCH_KEY.test(k)) { const it = c.item(g); if (it) slots[k] = it; }
    for (const [k, p] of Object.entries(obj(data.pos))) {
      if (!PITCH_KEY.test(k) || !p) continue;
      const x = num(p.x, 0, 100), y = num(p.y, 0, 100);
      if (x !== null && y !== null) pos[k] = { x, y };
    }
    for (const [tpl, o] of Object.entries(obj(data.labels)).slice(0, 20)) {
      if (!/^[a-z0-9_]{1,24}$/i.test(tpl)) continue;
      labels[tpl] = {};
      for (const [k, v] of Object.entries(obj(o))) if (PITCH_KEY.test(k)) labels[tpl][k] = str(v, 40);
    }
    out = { title, formation, template, slots, labels, pos, pool: c.items(data.pool) };
  } else if (mode === 'bracket') {
    const size = Number(data.size);
    if (!BR_SIZES.includes(size) || !Array.isArray(data.entries)) throw bad('Chaveamento inválido.');
    const entries = Array.from({ length: size }, (_, i) => (data.entries[i] ? c.item(data.entries[i]) : null));
    const picks = {};
    for (const [k, v] of Object.entries(obj(data.picks))) if (/^\d{1,2}-\d{1,2}$/.test(k) && (v === 0 || v === 1)) picks[k] = v;
    out = { title, size, entries, picks };
  } else throw bad('Formato de lista desconhecido.');
  if (!c.total) throw bad('Coloque pelo menos um item na lista antes de compartilhar.');
  c.checkPhotos();
  return { data: out, photos: c.photos, total: c.total };
}

// A imagem chega como data URL; só JPEG ou PNG de verdade (confere os primeiros bytes).
function cleanImage(dataUrl) {
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad('Imagem da lista inválida.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE) throw bad('A imagem da lista ficou grande demais.', 413);
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, png = buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (!(m[1] === 'jpeg' ? jpeg : png)) throw bad('Imagem da lista inválida.');
  return { buf, type: 'image/' + m[1] };
}

const readShare = async (id) => (ID.test(id || '') ? store.getShare(id) : null);
const publicView = (s) => ({ id: s.id, mode: s.mode, cat: s.cat, title: s.data.title, data: s.data, photos: s.photos, n: s.n, created: s.created, updated: s.updated });

async function save(id, prev, b) {
  const mode = String(b.mode || '');
  const cat = CATS.includes(b.cat) ? b.cat : 'outros';
  const { data, photos, total } = cleanList(mode, b.data, b.lib);
  const img = cleanImage(b.image);
  const now = Date.now();
  const rec = { id, tokenHash: prev ? prev.tokenHash : null, mode, cat, data, photos, n: total, imgType: img.type, created: prev ? prev.created : now, updated: now };
  return { rec, img };
}

// Página HTML do link: o mesmo site, com título e prévia (Open Graph) da lista, para aparecer bonito no WhatsApp etc.
let indexHtml = null;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sharePage(req, s, publicDir) {
  if (!indexHtml || process.env.NODE_ENV !== 'production') indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const origin = (auth.isHttps(req) ? 'https' : 'http') + '://' + String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  const title = s.data.title + ' · ' + MODE_NAME[s.mode];
  const desc = `${MODE_NAME[s.mode]} com ${s.n} ${s.n === 1 ? 'item' : 'itens'}. Veja e faça a sua versão.`;
  const img = `${origin}/s/${s.id}.img?v=${s.updated}`;
  const meta = [
    `<meta name="robots" content="noindex">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Escalação">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta property="og:url" content="${escHtml(origin + '/s/' + s.id)}">`,
    `<meta property="og:image" content="${escHtml(img)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="description" content="${escHtml(desc)}">`,
  ].join('\n');
  return indexHtml.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)} — Escalação</title>\n${meta}`);
}

async function handle(req, res, url, publicDir) {
  const p = url.pathname, send = auth.send;

  // /s/<id>  e  /s/<id>.img
  let m;
  if ((m = /^\/s\/([A-Za-z0-9_-]{11})(\.img)?$/.exec(p)) && req.method === 'GET') {
    let s;
    try { s = await readShare(m[1]); } catch (e) { return auth.sendError(res, e), true; }
    if (m[2]) {
      if (!s) return send(res, 404, { error: 'Link não encontrado.' }), true;
      let buf;
      try { buf = await store.getShareImg(s.id); } catch (e) { return auth.sendError(res, e), true; }
      if (!buf) return send(res, 404, { error: 'Imagem não encontrada.' }), true;
      res.writeHead(200, { 'Content-Type': s.imgType, 'Cache-Control': 'public, max-age=300' });
      res.end(buf);
      return true;
    }
    // link inexistente: entrega o site mesmo assim, e ele mostra "link não encontrado"
    res.writeHead(s ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(s ? sharePage(req, s, publicDir) : fs.readFileSync(path.join(publicDir, 'index.html')));
    return true;
  }

  if (p !== '/api/share' && !p.startsWith('/api/share/')) return false;
  try {
    if (req.method !== 'GET' && !auth.originOk(req)) return send(res, 403, { error: 'Origem não permitida.' }), true;
    const id = p.split('/')[3];

    if (!id && req.method === 'POST') {
      if (auth.tooMany('share:' + auth.clientIp(req), 30, 3600e3, true)) return send(res, 429, { error: 'Muitos links criados seguidos. Tente de novo mais tarde.' }), true;
      const b = await auth.readJson(req, MAX_BODY);
      let nid; do { nid = crypto.randomBytes(8).toString('base64url'); } while (!ID.test(nid) || (await store.shareExists(nid)));
      const token = crypto.randomBytes(18).toString('base64url');
      const { rec, img } = await save(nid, null, b);
      rec.tokenHash = sha(token);
      await store.putShare(rec, img.buf);
      return send(res, 200, { id: nid, token, url: '/s/' + nid }), true;
    }

    const s = id && (await readShare(id));
    if (!s) return send(res, 404, { error: 'Link não encontrado ou desativado.' }), true;

    if (req.method === 'GET') {   // ?lite=1: só o resumo, sem a lista e as fotos (a página do link carrega mais rápido)
      const v = publicView(s);
      if (url.searchParams.get('lite')) { delete v.data; delete v.photos; }
      return send(res, 200, v), true;
    }

    const token = String(req.headers['x-share-token'] || '');
    if (!token || !safeEq(sha(token), s.tokenHash)) return send(res, 403, { error: 'Só quem criou o link pode alterá-lo.' }), true;

    if (req.method === 'PUT') {
      if (auth.tooMany('share:' + auth.clientIp(req), 60, 3600e3, true)) return send(res, 429, { error: 'Muitas atualizações seguidas. Tente de novo mais tarde.' }), true;
      const b = await auth.readJson(req, MAX_BODY);
      const { rec, img } = await save(s.id, s, b);
      await store.putShare(rec, img.buf);
      return send(res, 200, { id: s.id, url: '/s/' + s.id }), true;
    }
    if (req.method === 'DELETE') {
      await store.delShare(s.id);
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 405, { error: 'Método não permitido.' }), true;
  } catch (e) {
    return auth.sendError(res, e), true;
  }
}

module.exports = { handle, cleanList };
