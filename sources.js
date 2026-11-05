// Fontes de busca por categoria. Cada uma devolve itens { id, name, sub, r, thumb }:
//   r = referência da imagem, entregue pelo endpoint /cover (o servidor busca e entrega; nada é guardado aqui).
// Chaves e endereços vêm de variáveis de ambiente (os endereços só mudam nos testes).
const UA = 'escalacao-games/1.0 (projeto pessoal)';
const URLS = {
  steam: process.env.STEAM_URL || 'https://store.steampowered.com/api/storesearch/',
  spotifyToken: process.env.SPOTIFY_TOKEN_URL || 'https://accounts.spotify.com/api/token',
  spotify: process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1/search',
  itunes: process.env.ITUNES_URL || 'https://itunes.apple.com/search',
  tvmaze: process.env.TVMAZE_URL || 'https://api.tvmaze.com/search/shows',
  tmdb: process.env.TMDB_URL || 'https://api.themoviedb.org/3/search/',
  jikan: process.env.JIKAN_URL || 'https://api.jikan.moe/v4/anime',
  openlibrary: process.env.OPENLIBRARY_URL || 'https://openlibrary.org/search.json',
  anilist: process.env.ANILIST_URL || 'https://graphql.anilist.co',
};
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID || '', SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const hasSpotify = !!(SPOTIFY_ID && SPOTIFY_SECRET);

async function getJson(url, opts) {
  let r;
  try { r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(9000) }, opts)); }
  catch (e) { console.error('busca falhou', new URL(url).host, e.message, e.cause && (e.cause.code || e.cause.message)); throw new Error('não foi possível conectar a ' + new URL(url).host + (e.cause && e.cause.code ? ' (' + e.cause.code + ')' : '') + '.'); }
  if (!r.ok) throw new Error('O serviço de busca respondeu ' + r.status + '.');
  return r.json();
}
const ref = (u) => 'u:' + u;
const item = (id, name, sub, r, p) => Object.assign({ id, name: String(name).slice(0, 80), sub: sub ? String(sub).slice(0, 60) : '', r, thumb: '/cover?r=' + encodeURIComponent(r) }, p ? { p } : {});
// p = como ouvir: 'sp:track:ID' (player do Spotify) ou 'it:https://…' (prévia de 30 s da Apple)
const PLAY = /^(sp:(track|album|artist):[A-Za-z0-9]{10,32}|it:https:\/\/[a-z0-9.-]+\.(itunes\.apple\.com|mzstatic\.com)\/[\w\-./%~+=]{1,300})$/;
const validPlay = (p) => typeof p === 'string' && p.length <= 400 && PLAY.test(p);
const year = (d) => (d ? String(d).slice(0, 4) : '');

// ----- Steam (sem chave)
async function steam(q) {
  const d = await getJson(URLS.steam + '?' + new URLSearchParams({ term: q, l: 'portuguese', cc: 'BR' }));
  return (d.items || []).filter((i) => i.type === 'app' && /^\d{1,10}$/.test(String(i.id))).slice(0, 20).map((i) => item('steam:' + i.id, i.name, 'Steam', 'steam:' + i.id));
}

// ----- Spotify (exige SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET)
let spTok = { v: '', exp: 0 };
async function spotifyToken() {
  if (spTok.v && Date.now() < spTok.exp) return spTok.v;
  const d = await getJson(URLS.spotifyToken, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(SPOTIFY_ID + ':' + SPOTIFY_SECRET).toString('base64') },
    body: 'grant_type=client_credentials',
  });
  spTok = { v: d.access_token, exp: Date.now() + Math.max(60, (d.expires_in || 3600) - 60) * 1000 };
  return spTok.v;
}
const pickImg = (imgs) => { const a = (imgs || []).filter((i) => i && i.url); return a.length ? (a.find((i) => i.width && i.width <= 400) || a[a.length - 1]).url : ''; };
async function spotify(q) {
  const tok = await spotifyToken();
  // desde fev/2026 o limite máximo por busca é 10; pedimos poucos de cada tipo
  const d = await getJson(URLS.spotify + '?' + new URLSearchParams({ q, type: 'track,album,artist', limit: '5', market: 'BR' }), { headers: { 'User-Agent': UA, Authorization: 'Bearer ' + tok } });
  const out = [];
  const add = (id, name, sub, img, type) => { if (img) out.push(item('spotify:' + id, name, sub, ref(img), `sp:${type}:${id}`)); };
  const L = (k) => (d[k] && d[k].items) || [];
  const n = Math.max(L('tracks').length, L('albums').length, L('artists').length);
  for (let i = 0; i < n; i++) {   // intercala os três tipos
    const t = L('tracks')[i], a = L('albums')[i], r = L('artists')[i];
    if (t) add(t.id, `${t.name} — ${(t.artists || [])[0] ? t.artists[0].name : ''}`.replace(/ — $/, ''), 'Música · Spotify', pickImg(t.album && t.album.images), 'track');
    if (a) add(a.id, `${a.name} — ${(a.artists || [])[0] ? a.artists[0].name : ''}`.replace(/ — $/, ''), 'Álbum · Spotify', pickImg(a.images), 'album');
    if (r) add(r.id, r.name, 'Artista · Spotify', pickImg(r.images), 'artist');
  }
  return out;
}

// ----- iTunes (sem chave): alternativa para músicas quando o Spotify não está configurado
async function itunes(q) {
  const call = (entity) => getJson(URLS.itunes + '?' + new URLSearchParams({ term: q, media: 'music', entity, limit: '10', country: 'BR' }));
  const [songs, albums] = await Promise.all([call('song'), call('album')]);
  const big = (u) => String(u || '').replace(/\/\d+x\d+bb\./, '/600x600bb.');
  const out = [];
  const n = Math.max((songs.results || []).length, (albums.results || []).length);
  for (let i = 0; i < n; i++) {
    const s = (songs.results || [])[i], a = (albums.results || [])[i];
    if (s && s.artworkUrl100) out.push(item('itunes:' + s.trackId, `${s.trackName} — ${s.artistName}`, 'Música · Apple', ref(big(s.artworkUrl100)), s.previewUrl ? 'it:' + s.previewUrl : ''));
    if (a && a.artworkUrl100) out.push(item('itunes:' + a.collectionId, `${a.collectionName} — ${a.artistName}`, 'Álbum · Apple', ref(big(a.artworkUrl100))));
  }
  return out;
}

// ----- Alternativas sem chave: filmes pela Apple (iTunes) e séries pelo TVMaze
async function itunesMovies(q) {
  const d = await getJson(URLS.itunes + '?' + new URLSearchParams({ term: q, media: 'movie', entity: 'movie', limit: '15', country: 'BR' }));
  return (d.results || []).filter((m) => m.artworkUrl100 && m.trackName).map((m) =>
    item('itunes:' + m.trackId, m.releaseDate ? `${m.trackName} (${String(m.releaseDate).slice(0, 4)})` : m.trackName, 'Filme · Apple', ref(String(m.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x900bb.'))));
}
async function tvmaze(q) {
  const d = await getJson(URLS.tvmaze + '?' + new URLSearchParams({ q }));
  return (Array.isArray(d) ? d : []).map((x) => x.show).filter((s) => s && s.image && (s.image.original || s.image.medium)).slice(0, 15).map((s) =>
    item('tvmaze:' + s.id, s.premiered ? `${s.name} (${String(s.premiered).slice(0, 4)})` : s.name, 'Série · TVMaze', ref(s.image.original || s.image.medium)));
}

// ----- TMDB (filmes e séries; exige TMDB_API_KEY, gratuita)
async function tmdb(kind, q) {
  const params = new URLSearchParams({ query: q, language: 'pt-BR', include_adult: 'false' });
  const opts = {};
  if (TMDB_KEY.length > 60) opts.headers = { 'User-Agent': UA, Accept: 'application/json', Authorization: 'Bearer ' + TMDB_KEY };   // token v4
  else params.set('api_key', TMDB_KEY);
  const d = await getJson(URLS.tmdb + kind + '?' + params, opts);
  return (d.results || []).filter((m) => m.poster_path).slice(0, 20).map((m) => {
    const y = year(m.release_date || m.first_air_date), name = m.title || m.name;
    return item('tmdb:' + kind + m.id, y ? `${name} (${y})` : name, kind === 'tv' ? 'Série · TMDB' : 'Filme · TMDB', ref('https://image.tmdb.org/t/p/w342' + m.poster_path));
  });
}

// ----- Animes (Jikan, dados do MyAnimeList; sem chave)
async function jikan(q) {
  try { const out = await jikanOnly(q); if (out.length) return out; } catch (e) { console.error('jikan:', e.message); }
  return anilist(q);   // se o Jikan estiver fora do ar ou bloqueado, usa o AniList
}
async function anilist(q) {
  const query = 'query($s:String){Page(perPage:15){media(search:$s,type:ANIME,isAdult:false,sort:SEARCH_MATCH){id title{romaji english} seasonYear coverImage{large}}}}';
  const d = await getJson(URLS.anilist, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables: { s: q } }) });
  return ((d.data && d.data.Page && d.data.Page.media) || []).filter((m) => m.coverImage && m.coverImage.large).map((m) =>
    item('anilist:' + m.id, m.title.english || m.title.romaji, m.seasonYear ? 'Anime · ' + m.seasonYear : 'Anime', ref(m.coverImage.large)));
}
async function jikanOnly(q) {
  const d = await getJson(URLS.jikan + '?' + new URLSearchParams({ q, limit: '15', sfw: 'true' }));
  return (d.data || []).map((a) => ({ a, img: a.images && a.images.jpg && (a.images.jpg.large_image_url || a.images.jpg.image_url) }))
    .filter((x) => x.img).map(({ a, img }) => item('jikan:' + a.mal_id, a.title_english || a.title, a.year ? 'Anime · ' + a.year : 'Anime', ref(img)));
}

// ----- Livros (Open Library; sem chave)
async function openlibrary(q) {
  const d = await getJson(URLS.openlibrary + '?' + new URLSearchParams({ q, limit: '15', fields: 'key,title,author_name,cover_i,first_publish_year' }));
  return (d.docs || []).filter((b) => b.cover_i && /^\d+$/.test(String(b.cover_i))).map((b) =>
    item('ol:' + String(b.key).replace(/\W/g, ''), b.title, [b.author_name && b.author_name[0], b.first_publish_year].filter(Boolean).join(' · '), ref(`https://covers.openlibrary.org/b/id/${b.cover_i}-L.jpg`)));
}

const NEEDS = {
  spotify: 'A busca no Spotify ainda não foi configurada neste site (faltam SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET).',
  tmdb_movie: 'A busca de filmes ainda não foi configurada neste site (falta TMDB_API_KEY).',
  tmdb_tv: 'A busca de séries ainda não foi configurada neste site (falta TMDB_API_KEY).',
};
// "music" usa o Spotify quando há credenciais e, sem elas, o iTunes.
const PROVIDERS = {
  steam, music: (q) => (hasSpotify ? spotify(q) : itunes(q)), tmdb_movie: (q) => (TMDB_KEY ? tmdb('movie', q).catch(() => itunesMovies(q)) : itunesMovies(q)), tmdb_tv: (q) => (TMDB_KEY ? tmdb('tv', q).catch(() => tvmaze(q)) : tvmaze(q)), jikan, openlibrary,
};
const available = () => ({ steam: true, music: true, tmdb_movie: true, tmdb_tv: true, tmdb: !!TMDB_KEY, jikan: true, openlibrary: true, spotify: hasSpotify });

const cache = new Map();
async function search(source, q) {
  const fn = PROVIDERS[source];
  if (!fn) throw Object.assign(new Error('Fonte desconhecida.'), { code: 400 });
  const key = source + '|' + q.toLowerCase(), hit = cache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.items;
  const items = await fn(q);
  cache.set(key, { t: Date.now(), items });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return items;
}

// URLs de imagem de cada referência de capa: "steam:ID" tenta a vertical e cai para a horizontal; "u:URL" é um endereço permitido.
function coverUrls(r) {
  let m;
  if ((m = /^steam:(\d{1,10})$/.exec(r))) {
    const cf = `https://cdn.cloudflare.steamstatic.com/steam/apps/${m[1]}`, ff = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${m[1]}`;
    return [`${cf}/library_600x900.jpg`, `${ff}/library_600x900.jpg`, `${cf}/header.jpg`, `${ff}/header.jpg`, `${cf}/capsule_231x87.jpg`];
  }
  if (/^u:https?:\/\/[^\s]{1,500}$/.test(r)) return [r.slice(2)];
  return null;
}
const validRef = (r) => typeof r === 'string' && r.length <= 520 && !!coverUrls(r);

module.exports = { search, available, coverUrls, validRef, validPlay, hasSpotify };