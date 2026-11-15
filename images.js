// Busca de imagens livres: Openverse, Wikimedia Commons e (com PEXELS_API_KEY) Pexels.
// Todas as fontes são consultadas em paralelo, com o termo original e a tradução para inglês;
// os resultados são pontuados por relevância e qualidade, sem repetidos, e paginados.
const OPENVERSE = process.env.OPENVERSE_URL || 'https://api.openverse.org/v1/images/';
const COMMONS = process.env.COMMONS_URL || 'https://commons.wikimedia.org/w/api.php';
const TRANSLATE = process.env.TRANSLATE_URL || 'https://api.mymemory.translated.net/get';
const PEXELS = process.env.PEXELS_URL || 'https://api.pexels.com/v1/search';
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const UA = 'escalacao-games/1.0 (projeto pessoal; busca de imagens livres)';
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
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('Serviço de imagens respondeu ' + r.status);
  return r.json();
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
async function toEnglish(term) {
  const key = fold(term);
  if (DICT[key]) return DICT[key];
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

const JUNK_NAME = /^(img|dsc|dscn|dscf|pict?|p|image|photo|file|screenshot|untitled)[\s_-]*\d+/i;
const OFF_TOPIC = /\b(map|mapa|diagram|chart|graph|logo|flag|bandeira|coat of arms|brasao|plan|planta|scan|document|stamp|selo|signature|assinatura)\b/;

// Pontua relevância (palavras no título e nas etiquetas) e qualidade (tamanho, proporção, nome).
function score(item, rank, qWords, qText) {
  const name = fold(item.name), tags = fold(item.tags);
  let s = 0;
  for (const set of qWords) {
    if (!set.length) continue;
    const inName = set.filter((w) => name.includes(w)).length / set.length;
    const inTags = set.filter((w) => tags.includes(w)).length / set.length;
    s = Math.max(s, inName * 3 + inTags * 1.5);
  }
  if (qText.some((t) => t && name.includes(t))) s += 1;
  const { w, h } = item;
  if (w && h) {
    const side = Math.min(w, h), ratio = Math.max(w, h) / side;
    if (side < 300) s -= 3; else if (side < 600) s -= 1; else if (side >= 1200) s += 0.5;
    if (ratio > 2.5) s -= 1.5;
  }
  if (JUNK_NAME.test(item.name.trim()) || !/[a-z]{3}/i.test(item.name)) s -= 1;
  if (OFF_TOPIC.test(name) && !qText.some((t) => OFF_TOPIC.test(t))) s -= 2;
  s += { px: 1, ov: 0, wc: -0.3 }[item.src] || 0;
  return s - rank * 0.04;   // a ordem da própria fonte desempata
}

const dupKey = (i) => fold(i.name) + '|' + fold(i.author);

async function searchImages(term, page = 1) {
  page = Math.min(Math.max(1, Math.floor(Number(page)) || 1), MAX_PAGE);
  return cached('img:' + fold(term) + ':' + page, 3600e3, async () => {
    let calls = 0, failures = 0, more = false;
    const run = async (fn, q) => {
      calls++;
      try { const r = await fn(q, page); more = more || r.more; return r.items; } catch (_) { failures++; return []; }
    };
    // O termo original já sai para todas as fontes enquanto a tradução é feita.
    const original = [run(openverse, term), run(commons, term)];
    if (PEXELS_KEY) original.push(run(pexels, term));
    const translated = toEnglish(term).then((en) => (en ? Promise.all([run(openverse, en), run(commons, en)]).then((l) => ({ en, l })) : { en: null, l: [] }));
    const [lists, tr] = await Promise.all([Promise.all(original), translated]);
    if (calls && failures === calls) throw new Error('Os serviços de imagens não responderam.');

    const qWords = [words(term), words(tr.en)], qText = [fold(term), fold(tr.en)];
    const seenId = new Set(), seenKey = new Set(), ranked = [];
    for (const list of [...lists, ...tr.l]) {
      list.forEach((item, rank) => {
        if (!item.thumb || !okThumb(item.thumb)) return;
        if (item.w && item.h && Math.min(item.w, item.h) < 150) return;
        const k = dupKey(item);
        if (seenId.has(item.id) || seenKey.has(k)) return;
        seenId.add(item.id); seenKey.add(k);
        ranked.push({ item, s: score(item, rank, qWords, qText) });
      });
    }
    ranked.sort((a, b) => b.s - a.s);
    const items = ranked.slice(0, PAGE_SIZE).map(({ item: { id, name, thumb, author, license, page: p } }) => ({ id, name, thumb, author, license, page: p }));
    return { items, more: more && page < MAX_PAGE, page, partial: failures > 0 };
  });
}

module.exports = { searchImages, hostOk, ALLOWED_HOSTS, hasPexels: !!PEXELS_KEY };
