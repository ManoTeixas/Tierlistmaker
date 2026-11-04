// Servidor sem dependências (Node 18+).  Uso:  node server.js
// Serve o site da pasta /public e faz de ponte para a Steam, porque o navegador
// não consegue chamar a API da loja direto (a Steam não libera CORS).
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (compatible; escalacao-games/1.0)';
const TTL = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const jsonCache = new Map(); // chave -> { t, data }
const imgCache = new Map(); // "id:kind" -> { buf, type }

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function steamJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('A Steam respondeu ' + r.status);
  return r.json();
}

async function cachedJson(key, load) {
  const hit = jsonCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  const data = await load();
  jsonCache.set(key, { t: Date.now(), data });
  if (jsonCache.size > 300) jsonCache.delete(jsonCache.keys().next().value);
  return data;
}

function searchGames(term) {
  return cachedJson('q:' + term.toLowerCase(), async () => {
    const qs = new URLSearchParams({ term, l: 'portuguese', cc: 'BR' });
    const data = await steamJson('https://store.steampowered.com/api/storesearch/?' + qs);
    return (data.items || [])
      .filter((i) => i.type === 'app')
      .slice(0, 20)
      .map((i) => ({
        id: i.id,
        name: i.name,
        price: i.price ? { final: i.price.final, currency: i.price.currency } : null,
      }));
  });
}

function featuredGames() {
  return cachedJson('featured', async () => {
    const data = await steamJson(
      'https://store.steampowered.com/api/featuredcategories?l=portuguese&cc=BR'
    );
    const items = (data.top_sellers && data.top_sellers.items) || [];
    return items.slice(0, 20).map((i) => ({
      id: i.id,
      name: i.name,
      price: i.final_price ? { final: i.final_price, currency: i.currency || 'BRL' } : null,
    }));
  });
}

// Algumas capas verticais não existem em jogos antigos: cai para a imagem horizontal.
function imageSources(id, kind) {
  const cf = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}`;
  const ff = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${id}`;
  const header = [`${cf}/header.jpg`, `${ff}/header.jpg`, `${cf}/capsule_231x87.jpg`];
  return kind === 'portrait'
    ? [`${cf}/library_600x900.jpg`, `${ff}/library_600x900.jpg`, ...header]
    : header;
}

async function getImage(id, kind) {
  const key = id + ':' + kind;
  if (imgCache.has(key)) return imgCache.get(key);
  for (const url of imageSources(id, kind)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) {
        const item = { buf: Buffer.from(await r.arrayBuffer()), type };
        imgCache.set(key, item);
        if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
        return item;
      }
    } catch (_) {
      /* tenta a próxima origem */
    }
  }
  return null;
}

/* ---------- Busca de imagens (bancos livres: Openverse e Wikimedia Commons) ---------- */
const OPENVERSE = process.env.OPENVERSE_URL || 'https://api.openverse.org/v1/images/';
const COMMONS = process.env.COMMONS_URL || 'https://commons.wikimedia.org/w/api.php';
const TRANSLATE = process.env.TRANSLATE_URL || 'https://api.mymemory.translated.net/get';
const IMG_UA = 'escalacao-games/1.0 (projeto pessoal; busca de imagens livres)';
// O proxy de imagens só fala com estes domínios (evita que o servidor seja usado para acessar qualquer endereço).
const ALLOWED_HOSTS = ['openverse.org', 'wikimedia.org', ...(process.env.ALLOW_HOSTS || '').split(',').filter(Boolean)];
const hostOk = (h) => ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
const proxied = (u) => '/imgproxy?u=' + encodeURIComponent(u);
const MAX_IMG = 6 * 1024 * 1024;

async function plainJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': IMG_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('Serviço de imagens respondeu ' + r.status);
  return r.json();
}

// A maioria dos bancos entende melhor inglês: traduz "comida" para "food" (se o serviço gratuito responder).
async function toEnglish(term) {
  try {
    const d = await cachedJson('tr:' + term.toLowerCase(), async () => {
      const qs = new URLSearchParams({ q: term, langpair: 'pt|en' });
      const r = await fetch(TRANSLATE + '?' + qs, { headers: { 'User-Agent': IMG_UA }, signal: AbortSignal.timeout(3500) });
      return r.ok ? r.json() : {};
    });
    const t = String((d.responseData && d.responseData.translatedText) || '').trim().toLowerCase();
    return t && t.length <= 80 && t !== term.toLowerCase() && Number(d.responseStatus) === 200 ? t : null;
  } catch (_) {
    return null;
  }
}

async function openverse(q) {
  const qs = new URLSearchParams({ q, page_size: '20', mature: 'false' });
  const d = await plainJson(OPENVERSE + '?' + qs);
  return (d.results || [])
    .map((r) => ({
      id: 'ov:' + r.id,
      name: String(r.title || q).slice(0, 60),
      thumb: r.thumbnail || '',
      author: r.creator || '',
      license: [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase(),
      page: r.foreign_landing_url || '',
    }))
    .filter((i) => {
      try { return i.thumb && hostOk(new URL(i.thumb).hostname); } catch (_) { return false; }
    });
}

async function commons(q) {
  const qs = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: q + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: '20',
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '360', format: 'json', formatversion: '2',
  });
  const d = await plainJson(COMMONS + '?' + qs);
  const pages = ((d.query && d.query.pages) || []).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages
    .map((p) => {
      const ii = (p.imageinfo || [])[0] || {};
      const meta = ii.extmetadata || {};
      const strip = (v) => String((v && v.value) || '').replace(/<[^>]*>/g, '').trim();
      return {
        id: 'wc:' + p.pageid,
        name: String(p.title || q).replace(/^File:/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').slice(0, 60),
        thumb: ii.thumburl || '',
        author: strip(meta.Artist).slice(0, 60),
        license: strip(meta.LicenseShortName),
        page: ii.descriptionurl || '',
      };
    })
    .filter((i) => {
      try { return i.thumb && hostOk(new URL(i.thumb).hostname); } catch (_) { return false; }
    });
}

function interleave(lists) {
  const out = [], seen = new Set();
  for (let i = 0; out.length < 30; i++) {
    let any = false;
    for (const l of lists) {
      if (i < l.length) {
        any = true;
        if (!seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]); }
      }
    }
    if (!any) break;
  }
  return out;
}

function searchImages(term) {
  return cachedJson('img:' + term.toLowerCase(), async () => {
    const en = await toEnglish(term);
    const terms = en ? [en, term] : [term];
    let failures = 0, calls = 0;
    const run = async (fn) => { calls++; try { return await fn(); } catch (_) { failures++; return []; } };
    let items = interleave(await Promise.all(terms.map((t) => run(() => openverse(t)))));
    if (items.length < 8) items = items.concat(interleave(await Promise.all(terms.map((t) => run(() => commons(t))))));
    if (!items.length && failures === calls) throw new Error('Os serviços de imagens não responderam.');
    return items.slice(0, 30).map((i) => ({ ...i, thumb: proxied(i.thumb) }));
  });
}

async function fetchImageSafe(raw) {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' && !(process.env.ALLOW_HTTP === '1' && url.protocol === 'http:')) throw new Error('endereço não permitido');
    if (!hostOk(url.hostname)) throw new Error('endereço não permitido');
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': IMG_UA }, signal: AbortSignal.timeout(10000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url); continue; }
    if (!r.ok) throw new Error('a imagem respondeu ' + r.status);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new Error('tipo de arquivo não permitido');
    if ((Number(r.headers.get('content-length')) || 0) > MAX_IMG) throw new Error('imagem grande demais');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMG) throw new Error('imagem grande demais');
    return { buf, type };
  }
  throw new Error('redirecionamentos demais');
}
const proxyCache = new Map();
async function getProxied(raw) {
  if (proxyCache.has(raw)) return proxyCache.get(raw);
  const item = await fetchImageSafe(raw);
  proxyCache.set(raw, item);
  if (proxyCache.size > 150) proxyCache.delete(proxyCache.keys().next().value);
  return item;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (await auth.handle(req, res, url)) return;
    if (url.pathname === '/api/search') {
      const term = (url.searchParams.get('term') || '').trim().slice(0, 80);
      if (term.length < 2) return sendJson(res, 400, { error: 'Digite pelo menos 2 letras.' });
      return sendJson(res, 200, { items: await searchGames(term) });
    }
    if (url.pathname === '/api/featured') {
      return sendJson(res, 200, { items: await featuredGames() });
    }
    if (url.pathname === '/api/images') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (q.length < 2) return sendJson(res, 400, { error: 'Digite pelo menos 2 letras.' });
      return sendJson(res, 200, { items: await searchImages(q) });
    }
    if (url.pathname === '/imgproxy') {
      let img;
      try { img = await getProxied(url.searchParams.get('u') || ''); } catch (e) { return sendJson(res, 400, { error: 'Imagem indisponível: ' + e.message }); }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(img.buf);
    }
    if (url.pathname === '/img') {
      const id = url.searchParams.get('id') || '';
      const kind = url.searchParams.get('kind') === 'portrait' ? 'portrait' : 'header';
      if (!/^\d{1,10}$/.test(id)) return sendJson(res, 400, { error: 'id inválido' });
      const img = await getImage(id, kind);
      if (!img) return sendJson(res, 404, { error: 'sem imagem' });
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(img.buf);
    }
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    return sendJson(res, 502, { error: 'Não consegui falar com a Steam agora. ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Escalação de jogos rodando em http://localhost:${PORT}  (dados em ${auth.DATA_DIR})`);
});
