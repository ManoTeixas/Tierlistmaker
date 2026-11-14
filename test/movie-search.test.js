const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadSources(key = '') {
  process.env.TMDB_API_KEY = key;
  delete require.cache[require.resolve('../sources')];
  return require('../sources');
}
const appleMovie = { trackId: 42, trackName: 'Filme externo', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg', releaseDate: '2025-01-01' };

test('catálogo encontra títulos, acentos e ano sem consultar a rede, mesmo com TMDB configurado', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('A busca local não deve usar a rede'); });
  const sources = loadSources('test-key');
  for (const q of ['Interestelar', 'INTERSTELLAR', 'interestelar 2014']) {
    const results = await sources.search('tmdb_movie', q);
    assert.equal(results[0].id, 'tmdb:movie157336');
    assert.equal(results[0].name, 'Interestelar (2014)');
    assert.equal(results[0].sub, 'Filme · Catálogo');
    assert.ok(sources.validRef(results[0].r));
    assert.match(results[0].thumb, /^\/cover\?r=/);
  }
  assert.equal((await sources.search('tmdb_movie', 'o poderoso chefao'))[0].name, 'O Poderoso Chefão (1972)');
  const results = await sources.search('tmdb_movie', 'a');
  assert.ok(results.length <= 20);
  assert.equal(new Set(results.map((m) => m.id)).size, results.length);
});

test('filme ausente usa Apple e conserva o cache da busca', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ results: [appleMovie] }) };
  });
  const sources = loadSources();
  const results = await sources.search('tmdb_movie', 'zzfilmeausentedocatalogozz');
  assert.equal(results[0].id, 'itunes:42');
  assert.equal(results.length, 1);
  assert.equal(calls.length, 2); // Brasil e EUA, deduplicados pelo ID.
  assert.ok(calls.every((url) => url.includes('itunes')));
  await sources.search('tmdb_movie', 'zzfilmeausentedocatalogozz');
  assert.equal(calls.length, 2);
});

test('Apple sem resultados mantém a alternativa da Wikipédia', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => String(url).includes('itunes') ? { results: [] } : {
      query: { pages: [{ pageid: 99, title: 'Filme externo', description: 'filme de 2025', thumbnail: { source: 'https://upload.wikimedia.org/poster.jpg' } }] },
    } };
  });
  const results = await loadSources().search('tmdb_movie', 'zzalternativawikizz');
  assert.equal(results[0].id, 'wiki:99');
  assert.equal(calls.length, 4);
});

test('TMDB configurado é consultado depois do catálogo', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ results: [{ id: 123, title: 'Filme TMDB', release_date: '2026-01-01', poster_path: '/poster.jpg' }] }) };
  });
  const results = await loadSources('test-key').search('tmdb_movie', 'zzalternativatmdbzz');
  assert.equal(results[0].id, 'tmdb:movie123');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('themoviedb'));
});

test('TMDB vazio ou indisponível permite a busca na Apple', async (t) => {
  for (const fail of [false, true]) {
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url).includes('themoviedb')) {
        if (fail) return { ok: false, status: 503 };
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return { ok: true, json: async () => ({ results: [appleMovie] }) };
    });
    assert.equal((await loadSources('test-key').search('tmdb_movie', 'zzfallbacktmdbzz'))[0].id, 'itunes:42');
    t.mock.restoreAll();
  }
});
