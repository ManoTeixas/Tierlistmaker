// Servidor Node 18+.  Uso:  node server.js   (com DATABASE_URL, guarda tudo no Postgres; veja store.js)
// Serve o site da pasta /public, contas e comunidade (auth.js, community.js)
// e faz a busca de imagens livres (images.js: Openverse, Wikimedia Commons e Pexels).
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const community = require('./community');
const sources = require('./sources');
const share = require('./share');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};


function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const images = require('./images');
const IMG_UA = 'escalacao-games/1.0 (projeto pessoal; busca de imagens livres)';
// O proxy de imagens só fala com estes domínios (evita que o servidor seja usado para acessar qualquer endereço).
const ALLOWED_HOSTS = [...images.ALLOWED_HOSTS, 'steamstatic.com', 'scdn.co', 'tmdb.org', 'mzstatic.com', 'myanimelist.net', 'anilist.co', 'tvmaze.com', 'openlibrary.org', 'archive.org', ...(process.env.ALLOW_HOSTS || '').split(',').filter(Boolean)];
const hostOk = (h) => ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
const proxied = (u) => '/imgproxy?u=' + encodeURIComponent(u);
const MAX_IMG = 6 * 1024 * 1024;
async function searchImages(q, page, cat) {
  const r = await images.searchImages(q, page, cat);
  return { items: r.items.map((i) => ({ ...i, thumb: proxied(i.thumb) })), more: r.more, page: r.page };
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
  if (proxyCache.size > 400) proxyCache.delete(proxyCache.keys().next().value);
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
    if (await community.handle(req, res, url)) return;
    if (await share.handle(req, res, url, PUBLIC)) return;
    if (url.pathname === '/api/sources') return sendJson(res, 200, { available: sources.available() });
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80), source = url.searchParams.get('source') || '';
      if (q.length < 2) return sendJson(res, 400, { error: 'Digite pelo menos 2 letras.' });
      if (source === 'web') return sendJson(res, 200, await searchImages(q, url.searchParams.get('page'), url.searchParams.get('cat') || ''));
      try { return sendJson(res, 200, { items: await sources.search(source, q) }); }
      catch (e) { return sendJson(res, e.code || 502, { error: e.code ? e.message : 'Não consegui falar com o serviço de busca agora. ' + e.message }); }
    }
    if (url.pathname === '/cover') {   // capa de uma fonte: o servidor busca (só em endereços permitidos) e entrega
      const urls = sources.coverUrls(url.searchParams.get('r') || '');
      if (!urls) return sendJson(res, 400, { error: 'Referência inválida.' });
      for (const u of urls) {
        try { const img = await getProxied(u); res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=86400' }); return res.end(img.buf); } catch (_) { /* tenta a próxima */ }
      }
      return sendJson(res, 404, { error: 'Sem imagem.' });
    }
    if (url.pathname === '/api/images') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (q.length < 2) return sendJson(res, 400, { error: 'Digite pelo menos 2 letras.' });
      return sendJson(res, 200, await searchImages(q, url.searchParams.get('page'), url.searchParams.get('cat') || ''));
    }
    if (url.pathname === '/imgproxy') {
      let img;
      try { img = await getProxied(url.searchParams.get('u') || ''); } catch (e) { return sendJson(res, 400, { error: 'Imagem indisponível: ' + e.message }); }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(img.buf);
    }
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    return sendJson(res, 502, { error: 'Não consegui falar com o serviço agora. ' + e.message });
  }
});

// Só aceita conexões depois de carregar contas, sessões e o índice da comunidade.
Promise.all([auth.ready, community.ready]).then(() => {
  server.listen(PORT, () => {
    console.log(`Escalação rodando em http://localhost:${PORT}  (dados em ${require('./store').where})`);
  });
}).catch((e) => {
  console.error('Não consegui abrir o armazenamento:', e.message);
  process.exit(1);
});