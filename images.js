// Busca de imagens livres: Wikipédia, Openverse, Wikimedia Commons e (com PEXELS_API_KEY) Pexels.
// 1) A Wikipédia em português "entende" o termo: acha o artigo (coxinha, Messi, cachorro → Cão),
//    dá a imagem principal dele (vem primeiro) e o título do artigo em inglês, que é a tradução usada.
//    O tradutor automático só entra quando não há artigo (ele erra nomes próprios: "brigadeiro" → "dock").
// 2) Todas as fontes rodam em paralelo com o termo original e a tradução.
// 3) Os resultados são pontuados por relevância e qualidade, sem repetidos, e paginados.
const OPENVERSE = process.env.OPENVERSE_URL || 'https://api.openverse.org/v1/images/';
const COMMONS = process.env.COMMONS_URL || 'https://commons.wikimedia.org/w/api.php';
const TRANSLATE = process.env.TRANSLATE_URL || 'https://api.mymemory.translated.net/get';
const PEXELS = process.env.PEXELS_URL || 'https://api.pexels.com/v1/search';
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const WIKI = process.env.WIKI_URL || 'https://pt.wikipedia.org/w/api.php';
// A Wikimedia pede um User-Agent com contato; sem ele, as buscas podem ser bloqueadas.
const UA = process.env.IMG_USER_AGENT || 'escalacao-games/1.0 (https://github.com/ManoTeixas/Tierlistmaker)';
const PER_SOURCE = 20, PAGE_SIZE = 40, MAX_PAGE = 10;

const ALLOWED_HOSTS = ['openverse.org', 'wikimedia.org', 'pexels.com'];
const hostOk = (h) => ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
const okThumb = (u) => { try { return hostOk(new URL(u).hostname); } catch (_) { return false; } };

// Cache em memória: buscas por 1 hora, traduções por 1 dia.
const cache = new Map();
async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const data = await load();
  if (!(data && data.partial)) cache.set(key, { t: Date.now(), data });   // resultado incompleto (fonte falhou) não fica guardado
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

async function getJson(url, headers = {}, ms = 8000) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(ms) });
    if (r.ok) return r.json();
    // limite de requisições ou instabilidade: tenta mais uma vez, rapidinho
    if (attempt === 0 && (r.status === 429 || r.status >= 500)) { await new Promise((res) => setTimeout(res, 400)); continue; }
    throw new Error('respondeu ' + r.status);
  }
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set('a o as os de da do das dos e em no na nos nas um uma com para por the of and in on for with to an'.split(' '));
const words = (s) => fold(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

// Termos comuns traduzidos sem rede (inclui os atalhos da tela).
const DICT = {
  comida: 'food', animais: 'animals', carros: 'cars', praias: 'beach', praia: 'beach', futebol: 'soccer', paisagens: 'landscape',
  paisagem: 'landscape', musica: 'music', arquitetura: 'architecture', cachorro: 'dog', gato: 'cat', cidade: 'city', montanha: 'mountain',
  flores: 'flowers', flor: 'flower', mar: 'sea', ceu: 'sky', floresta: 'forest', frutas: 'fruits', pizza: 'pizza', bolo: 'cake',
};
// Artigo da Wikipédia com exatamente esse nome (seguindo redirecionamentos: "cachorro" → "Cão").
async function wikiLookup(term) {
  try {
    return await cached('wk:' + fold(term), 24 * 3600e3, async () => {
      const d = await getJson(WIKI + '?' + new URLSearchParams({
        action: 'query', titles: term, redirects: '1', prop: 'langlinks|pageimages|pageprops', lllang: 'en',
        piprop: 'thumbnail|name|original', pithumbsize: '480', pilicense: 'free', ppprop: 'disambiguation', format: 'json', formatversion: '2',
      }), {}, 3000);
      const p = ((d.query && d.query.pages) || [])[0];
      if (!p || p.missing || p.invalid || (p.pageprops && p.pageprops.disambiguation !== undefined)) return { found: false };
      const en = p.langlinks && p.langlinks[0] && p.langlinks[0].title;
      return { found: true, title: p.title, en: en ? en.replace(/\s*\([^)]*\)\s*$/, '') : null, lead: p.thumbnail && p.pageimage ? wikiItem(p, 'wl') : null };
    });
  } catch (e) {
    console.error('imagens: wikipédia', e.message);
    return { found: false };
  }
}
function wikiItem(p, kind) {
  return {
    id: kind + ':' + p.pageimage, src: 'wp', lead: kind === 'wl',
    name: String(p.title).slice(0, 60),
    thumb: p.thumbnail.source,
    author: '', license: 'Livre (Wikipédia)',
    page: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(p.pageimage),
    w: (p.original && p.original.width) || 0, h: (p.original && p.original.height) || 0,
    tags: p.description || '',
  };
}
// Imagens principais dos artigos que a busca da Wikipédia encontra (ex.: "brigadeiro" → Brigadeiro (doce)).
async function wikiSearch(q, page) {
  if (page > 1) return { items: [], more: false };
  const d = await getJson(WIKI + '?' + new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: q, gsrlimit: '12', prop: 'pageimages|description',
    piprop: 'thumbnail|name|original', pithumbsize: '480', pilicense: 'free', format: 'json', formatversion: '2',
  }));
  const items = ((d.query && d.query.pages) || []).sort((a, b) => (a.index || 0) - (b.index || 0)).filter((p) => p.thumbnail && p.pageimage).map((p) => wikiItem(p, 'wp'));
  return { items, more: false };
}

// Tradução: título do artigo em inglês > dicionário > tradutor automático (só se não houver artigo).
// "trust": quanto confiar nos resultados da tradução em relação aos do termo original.
async function translate(term, wk) {
  const key = fold(term);
  if (wk.found) {
    if (wk.en && fold(wk.en) !== key) return { en: wk.en, trust: 1.15 };
    return DICT[key] ? { en: DICT[key], trust: 1.15 } : { en: null };   // artigo sem tradução diferente: é nome próprio, não traduz
  }
  if (DICT[key]) return { en: DICT[key], trust: 1.15 };
  const t = await machineTranslate(term);
  return t ? { en: t, trust: 0.6 } : { en: null };
}
async function machineTranslate(term) {
  const key = fold(term);
  try {
    const d = await cached('tr:' + key, 24 * 3600e3, () => getJson(TRANSLATE + '?' + new URLSearchParams({ q: term, langpair: 'pt|en' }), {}, 2500));
    const t = String((d.responseData && d.responseData.translatedText) || '').trim().toLowerCase();
    if (Number(d.responseStatus) !== 200 || !t || t.length > 80 || /mymemory|warning|quota/i.test(t)) return null;
    return fold(t) === key ? null : t;
  } catch (_) {
    return null;
  }
}

async function openverse(q, page) {
  const d = await getJson(OPENVERSE + '?' + new URLSearchParams({ q, page_size: String(PER_SOURCE), page: String(page), mature: 'false' }));
  const items = (d.results || []).map((r) => ({
    id: 'ov:' + r.id, src: 'ov',
    name: String(r.title || q).slice(0, 60),
    thumb: r.thumbnail || '',
    author: r.creator || '',
    license: [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase(),
    page: r.foreign_landing_url || '',
    w: Number(r.width) || 0, h: Number(r.height) || 0,
    tags: (r.tags || []).map((t) => t && t.name).filter(Boolean).join(' '),
  }));
  return { items, more: page < (Number(d.page_count) || 0) };
}

async function commons(q, page) {
  const d = await getJson(COMMONS + '?' + new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: q + ' filetype:bitmap', gsrnamespace: '6', gsrlimit: String(PER_SOURCE),
    gsroffset: String((page - 1) * PER_SOURCE), prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '360',
    format: 'json', formatversion: '2',
  }));
  const strip = (v) => String((v && v.value) || '').replace(/<[^>]*>/g, '').trim();
  const items = ((d.query && d.query.pages) || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((p) => {
    const ii = (p.imageinfo || [])[0] || {}, meta = ii.extmetadata || {};
    return {
      id: 'wc:' + p.pageid, src: 'wc', mime: ii.mime || '',
      name: String(p.title || q).replace(/^File:/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').slice(0, 60),
      thumb: ii.thumburl || '',
      author: strip(meta.Artist).slice(0, 60),
      license: strip(meta.LicenseShortName),
      page: ii.descriptionurl || '',
      w: Number(ii.width) || 0, h: Number(ii.height) || 0,
      tags: strip(meta.ImageDescription).slice(0, 300),
    };
  }).filter((i) => !i.mime || /^image\/(jpeg|png|webp)$/.test(i.mime));
  return { items, more: !!d.continue };
}

// O Pexels entende português direto (locale=pt-BR), então não precisa da tradução.
async function pexels(q, page) {
  const d = await getJson(PEXELS + '?' + new URLSearchParams({ query: q, per_page: String(PER_SOURCE), page: String(page), locale: 'pt-BR' }), { Authorization: PEXELS_KEY });
  const items = (d.photos || []).map((p) => ({
    id: 'px:' + p.id, src: 'px',
    name: String(p.alt || q).slice(0, 60),
    thumb: (p.src && (p.src.medium || p.src.small)) || '',
    author: p.photographer || '',
    license: 'Pexels',
    page: p.url || '',
    w: Number(p.width) || 0, h: Number(p.height) || 0,
    tags: p.alt || '',
  }));
  return { items, more: !!d.next_page };
}

// Conteúdo adulto: o Commons não tem filtro (o Openverse já recebe mature=false). O site é para mandar aos amigos.
const ADULT = /\b(erotic|erotica|erotico|porn|porno|pornographic|pornografia|xxx|nsfw|nude|nudes|nudity|naked|nua|nudez|sex|sexo|sexual|fetish|fetiche|bdsm|playboy|penthouse|hentai|stripper|striptease|topless|genitals|genitalia|penis|vagina)\b/;   // \b: "Essex" não conta
const isAdult = (item) => ADULT.test(fold(item.name)) || ADULT.test(fold(item.tags));
const JUNK_NAME = /^(img|dsc|dscn|dscf|pict?|p|image|photo|file|screenshot|untitled)[\s_-]*\d+/i;
const OFF_TOPIC = /\b(map|mapa|diagram|chart|graph|logo|flag|bandeira|coat of arms|brasao|plan|planta|scan|document|stamp|selo|signature|assinatura)\b/;

// Contexto da categoria da lista: palavras que indicam o sentido certo do termo (em português e inglês).
// Numa lista de Comida, "brigadeiro" é o doce, não a avenida nem o posto militar.
const CONTEXT = {
  comida: { en: 'food', words: ['food', 'dish', 'cuisine', 'dessert', 'sweet', 'sweets', 'snack', 'cake', 'bread', 'candy', 'comida', 'prato', 'doce', 'culinaria', 'sobremesa', 'salgado', 'lanche', 'bolo', 'receita', 'iguaria', 'gastronomia'] },
  filmes: { en: 'film', words: ['film', 'movie', 'cinema', 'poster', 'filme', 'longa metragem'] },
  series: { en: 'television series', words: ['television', 'tv', 'series', 'sitcom', 'serie', 'televisao', 'telenovela'] },
  animes: { en: 'anime', words: ['anime', 'manga', 'animation', 'animacao'] },
  jogos: { en: 'video game', words: ['game', 'video game', 'videogame', 'jogo', 'jogo eletronico', 'console'] },
  musica: { en: 'music', words: ['music', 'band', 'singer', 'album', 'song', 'concert', 'musica', 'banda', 'cantor', 'cantora', 'rapper', 'musician', 'musico', 'grupo musical'] },
  livros: { en: 'book', words: ['book', 'novel', 'author', 'writer', 'livro', 'romance', 'escritor', 'escritora', 'literatura'] },
  futebol: { en: 'football', words: ['football', 'soccer', 'futebol', 'footballer', 'futebolista', 'player', 'jogador', 'clube', 'club', 'stadium', 'estadio'] },
};
const hasWord = (text, w) => (' ' + text + ' ').includes(' ' + w + ' ');
const inContext = (item, ctx) => !!ctx && ctx.words.some((w) => hasWord(fold(item.name), w) || hasWord(fold(item.tags), w));

// Pontua relevância (palavras no título e nas etiquetas) e qualidade (tamanho, proporção, nome).
// q = [{ words, text, weight }] para o termo original, o título do artigo e a tradução.
function score(item, rank, q, ctx) {
  const name = fold(item.name), tags = fold(item.tags);
  let s = 0;
  for (const { words: set, text, weight } of q) {
    if (!set.length) continue;
    const inName = set.filter((w) => name.includes(w)).length / set.length;
    const inTags = set.filter((w) => tags.includes(w)).length / set.length;
    s = Math.max(s, (inName * 3 + inTags * 1.5 + (text && name.includes(text) ? 1 : 0)) * weight);
  }
  if (s === 0) s -= 1.5;   // não tem nenhuma palavra da busca
  if (item.src === 'wp' && q.some(({ words: set }) => set.length && set.every((w) => name.includes(w)))) s += 1.5;   // artigo sobre o assunto
  if (item.lead) s += 6;   // imagem principal do artigo exato: é "a" foto daquilo
  if (s > 0 && inContext(item, ctx)) s += 1.5;   // combina com a categoria da lista
  const qText = q.map((x) => x.text);
  const { w, h } = item;
  if (w && h) {
    const side = Math.min(w, h), ratio = Math.max(w, h) / side;
    if (side < 300) s -= 3; else if (side < 600) s -= 1; else if (side >= 1200) s += 0.5;
    if (ratio > 2.5) s -= 1.5;
  }
  if (JUNK_NAME.test(item.name.trim()) || !/[a-z]{3}/i.test(item.name)) s -= 1;
  if (OFF_TOPIC.test(name) && !qText.some((t) => OFF_TOPIC.test(t))) s -= 2;
  s += { px: 1, wp: 0.5, ov: 0, wc: -0.3 }[item.src] || 0;
  return s - rank * 0.04;   // a ordem da própria fonte desempata
}

const dupKey = (i) => fold(i.name) + '|' + fold(i.author);
// Mesma imagem da Wikimedia vinda por caminhos diferentes (artigo da Wikipédia e busca do Commons).
const fileKey = (u) => { const m = /upload\.wikimedia\.org\/.+?\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/.exec(u); return m ? decodeURIComponent(m[1]).toLowerCase() : null; };

async function searchImages(term, page = 1, cat = '') {
  page = Math.min(Math.max(1, Math.floor(Number(page)) || 1), MAX_PAGE);
  const ctx = CONTEXT[cat] || null;
  return cached('img:' + fold(term) + ':' + page + ':' + (ctx ? cat : ''), 3600e3, async () => {
    let calls = 0, failures = 0, more = false;
    const run = async (fn, q) => {
      calls++;
      try { const r = await fn(q, page); more = more || r.more; return r.items; }
      catch (e) { failures++; console.error('imagens:', fn.name, JSON.stringify(q), e.message); return []; }
    };
    // O termo original já sai para todas as fontes enquanto a Wikipédia decide a tradução.
    const original = [run(openverse, term), run(commons, term), run(wikiSearch, term)];
    if (PEXELS_KEY) original.push(run(pexels, term));
    if (ctx) original.push(run(commons, term + ' ' + ctx.en));   // ex.: "brigadeiro food"
    const understood = wikiLookup(term).then(async (wk) => {
      const tr = await translate(term, wk);
      const l = tr.en ? await Promise.all([run(openverse, tr.en), run(commons, tr.en)]) : [];
      return { wk, tr, l };
    });
    const [lists, { wk, tr, l: trLists }] = await Promise.all([Promise.all(original), understood]);
    if (calls && failures === calls) throw new Error('Os serviços de imagens não responderam.');

    const q = [{ words: words(term), text: fold(term), weight: 1 }];
    if (wk.found && fold(wk.title) !== fold(term)) q.push({ words: words(wk.title), text: fold(wk.title), weight: 1 });   // "messi" → "Lionel Messi"
    // Termo ambíguo: a busca da Wikipédia achou artigos como "Brigadeiro (doce)" além do "Brigadeiro" (posto militar).
    // Aí o artigo exato pode ser o sentido errado: a tradução dele vale menos e a imagem dele não entra na frente.
    const t0 = fold(wk.found ? wk.title : term);
    const ambiguous = wk.found && lists[2].some((i) => fold(i.name) !== t0 && fold(i.name).startsWith(t0 + ' ') && /\(.+\)$/.test(i.name));
    if (tr.en) q.push({ words: words(tr.en), text: fold(tr.en), weight: ambiguous ? Math.min(tr.trust, 0.6) : tr.trust });
    const seenId = new Set(), seenKey = new Set(), ranked = [];
    // Imagem que vai na frente: a do artigo exato; se o termo é ambíguo, a do artigo que combina com a categoria
    // (ex.: "Brigadeiro (doce)" numa lista de Comida), e nenhuma se não der para saber.
    // Só artigos no formato "Termo (sentido)" contam como outro sentido do termo; "Batman v Superman" não.
    const sameTerm = (i) => fold(i.name) === t0 || (fold(i.name).startsWith(t0 + ' ') && fold(i.name.replace(/\s*\([^)]*\)$/, '')) === t0);
    const ctxArticle = ctx && (ambiguous || !wk.lead) && lists[2].find((i) => sameTerm(i) && inContext(i, ctx));
    let leadItem = null;
    if (ctxArticle) leadItem = { ...ctxArticle, lead: true };      // ambíguo: o sentido que combina com a categoria da lista
    else if (wk.lead && !ambiguous) leadItem = wk.lead;              // artigo exato, sem ambiguidade
    const lead = page === 1 && leadItem ? [[leadItem]] : [];
    for (const list of [...lead, ...lists, ...trLists]) {
      list.forEach((item, rank) => {
        if (!item.thumb || !okThumb(item.thumb) || isAdult(item)) return;
        if (item.w && item.h && Math.min(item.w, item.h) < 150) return;
        const k = dupKey(item), f = fileKey(item.thumb);
        if (seenId.has(item.id) || seenKey.has(k) || (f && seenKey.has(f))) return;
        seenId.add(item.id); seenKey.add(k); if (f) seenKey.add(f);
        ranked.push({ item, s: score(item, rank, q, ctx) });
      });
    }
    ranked.sort((a, b) => b.s - a.s);
    const items = ranked.slice(0, PAGE_SIZE).map(({ item: { id, name, thumb, author, license, page: p } }) => ({ id, name, thumb, author, license, page: p }));
    return { items, more: more && page < MAX_PAGE, page, partial: failures > 0 };
  });
}

module.exports = { searchImages, hostOk, ALLOWED_HOSTS, hasPexels: !!PEXELS_KEY };
