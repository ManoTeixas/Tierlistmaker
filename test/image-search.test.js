const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadImages(pexelsKey = '') {
  process.env.PEXELS_API_KEY = pexelsKey;
  delete require.cache[require.resolve('../images')];
  return require('../images');
}
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const ov = (id, title, extra = {}) => ({ id, title, thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`, creator: 'autor ' + id, license: 'by', license_version: '4.0', width: 1600, height: 1200, tags: [], ...extra });

function fakeNet(t, routes, calls = []) {
  t.mock.method(global, 'fetch', async (url) => {
    const u = new URL(url); calls.push(u);
    for (const [host, fn] of routes) if (u.host.includes(host)) return json(fn(u));
    if (u.host.includes('wikipedia')) return json({ query: { pages: u.searchParams.get('titles') ? [{ missing: true }] : [] } });   // sem artigo
    throw new Error('host inesperado ' + u.host);
  });
  return calls;
}

test('relevância e qualidade: título que bate e imagem grande vêm antes; miniaturas e mapas caem', async (t) => {
  fakeNet(t, [
    ['mymemory', () => ({ responseStatus: 200, responseData: { translatedText: 'red apple' } })],
    ['openverse', (u) => ({ page_count: 1, results: u.searchParams.get('q') === 'red apple' ? [
      ov('a', 'DSC_0001', { tags: [{ name: 'apple' }] }),
      ov('b', 'Red apple map'),
      ov('c', 'Red apple on table'),
      ov('e', 'Red apple basket'),
      ov('d', 'Red apple tiny', { width: 100, height: 90 }),
    ] : [] })],
    ['wikimedia', () => ({ query: { pages: [] } })],
  ]);
  const r = await loadImages().searchImages('maçã vermelha zz1');
  const ids = r.items.map((i) => i.id);
  assert.equal(ids[0], 'ov:c');
  assert.ok(!ids.includes('ov:d'), 'imagem minúscula é descartada');
  assert.ok(ids.indexOf('ov:b') > ids.indexOf('ov:e'), 'mapa fica abaixo de foto equivalente');
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['author', 'id', 'license', 'name', 'page', 'thumb']);
});

test('fontes rodam em paralelo com o termo original, sem esperar a tradução', async (t) => {
  let releaseTranslation;
  const gate = new Promise((res) => { releaseTranslation = res; });
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    const u = new URL(url); calls.push(u);
    if (u.host.includes('mymemory')) { await gate; return json({ responseStatus: 200, responseData: { translatedText: 'boat' } }); }
    if (u.host.includes('openverse')) return json({ page_count: 1, results: [] });
    return json({ query: { pages: [] } });
  });
  const p = loadImages().searchImages('barco zz2');
  await new Promise((res) => setImmediate(res));
  assert.ok(calls.some((u) => u.host.includes('openverse') && u.searchParams.get('q') === 'barco zz2'));
  assert.ok(calls.some((u) => u.host.includes('wikimedia')));
  releaseTranslation();
  await p;
  assert.ok(calls.some((u) => u.host.includes('openverse') && u.searchParams.get('q') === 'boat'));
});

test('paginação: repassa a página às fontes e informa se há mais', async (t) => {
  const calls = fakeNet(t, [
    ['mymemory', () => ({ responseStatus: 200, responseData: { translatedText: 'zz3 boat' } })],
    ['openverse', () => ({ page_count: 5, results: [ov('p2', 'boat zz3')] })],
    ['wikimedia', () => ({ query: { pages: [] }, continue: { gsroffset: 60 } })],
  ]);
  const r = await loadImages().searchImages('barco zz3', 2);
  assert.equal(r.page, 2);
  assert.equal(r.more, true);
  assert.ok(calls.filter((u) => u.host.includes('openverse')).every((u) => u.searchParams.get('page') === '2'));
  assert.ok(calls.filter((u) => u.host.includes('wikimedia')).every((u) => u.searchParams.get('gsroffset') === '20'));
});

test('termos comuns não usam o tradutor e Pexels entra com a chave', async (t) => {
  const calls = fakeNet(t, [
    ['openverse', () => ({ page_count: 1, results: [] })],
    ['wikimedia', () => ({ query: { pages: [] } })],
    ['pexels', () => ({ photos: [{ id: 7, alt: 'Prato de comida', photographer: 'Fulano', url: 'https://www.pexels.com/photo/7', width: 4000, height: 3000, src: { medium: 'https://images.pexels.com/7.jpg' } }] })],
  ]);
  const r = await loadImages('k').searchImages('comida');
  assert.ok(!calls.some((u) => u.host.includes('mymemory')));
  assert.ok(calls.some((u) => u.host.includes('openverse') && u.searchParams.get('q') === 'food'));
  assert.equal(r.items[0].id, 'px:7');
});

test('falha parcial não fica no cache; falha total vira erro', async (t) => {
  let ovUp = false;
  fakeNet(t, [
    ['mymemory', () => ({ responseStatus: 200, responseData: { translatedText: 'zz4' } })],
    ['openverse', () => { if (!ovUp) throw new Error('fora'); return { page_count: 1, results: [ov('x', 'zz4 boat')] }; }],
    ['wikimedia', () => ({ query: { pages: [] } })],
  ]);
  const images = loadImages();
  assert.equal((await images.searchImages('zz4')).items.length, 0);
  ovUp = true;
  assert.equal((await images.searchImages('zz4')).items.length, 1);

  t.mock.method(global, 'fetch', async () => { throw new Error('sem rede'); });
  await assert.rejects(loadImages().searchImages('zz5 qualquer'), /não responderam/);
});

const wikiPage = (title, file, extra = {}) => ({ title, pageimage: file, thumbnail: { source: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/480px-${file}` }, original: { width: 2000, height: 1500 }, ...extra });

test('artigo da Wikipédia: imagem principal vem primeiro e nome próprio não passa pelo tradutor', async (t) => {
  const calls = fakeNet(t, [
    ['wikipedia', (u) => (u.searchParams.get('titles')
      ? { query: { pages: [wikiPage('Coxinha', 'Coxinha_01.jpg', { langlinks: [{ lang: 'en', title: 'Coxinha' }] })] } }
      : { query: { pages: [] } })],
    ['openverse', () => ({ page_count: 1, results: [ov('c1', 'Coxinha frita'), ov('c2', 'Chicken thigh')] })],
    ['wikimedia', () => ({ query: { pages: [] } })],
  ]);
  const r = await loadImages().searchImages('coxinha');
  assert.equal(r.items[0].id, 'wl:Coxinha_01.jpg');
  assert.ok(!calls.some((u) => u.host.includes('mymemory')), 'não chama o tradutor automático');
  assert.ok(calls.every((u) => !u.host.includes('openverse') || u.searchParams.get('q') === 'coxinha'), 'não busca tradução');
});

test('tradução vem do título do artigo em inglês', async (t) => {
  const calls = fakeNet(t, [
    ['wikipedia', (u) => (u.searchParams.get('titles')
      ? { query: { pages: [wikiPage('Automóvel desportivo', 'Mx5.jpg', { langlinks: [{ lang: 'en', title: 'Sports car (vehicle)' }] })] } }
      : { query: { pages: [] } })],
    ['openverse', () => ({ page_count: 1, results: [] })],
    ['wikimedia', () => ({ query: { pages: [] } })],
  ]);
  await loadImages().searchImages('carro esportivo zz6');
  assert.ok(calls.some((u) => u.host.includes('openverse') && u.searchParams.get('q') === 'Sports car'));
  assert.ok(!calls.some((u) => u.host.includes('mymemory')));
});

test('termo ambíguo: o sentido certo achado na busca não perde para a tradução do artigo exato', async (t) => {
  fakeNet(t, [
    ['wikipedia', (u) => (u.searchParams.get('titles')
      ? { query: { pages: [wikiPage('Brigadeiro', 'Rank.jpg', { langlinks: [{ lang: 'en', title: 'Brigadier' }] })] } }
      : { query: { pages: [wikiPage('Brigadeiro (doce)', 'Doce.jpg')] } })],
    ['openverse', (u) => ({ page_count: 1, results: u.searchParams.get('q') === 'Brigadier' ? [ov('g1', 'Brigadier General Smith')] : [ov('b1', 'Brigadeiros na festa')] })],
    ['wikimedia', () => ({ query: { pages: [] } })],
  ]);
  const ids = (await loadImages().searchImages('brigadeiro')).items.map((i) => i.id);
  assert.equal(ids[0], 'wp:Doce.jpg');
  assert.ok(ids.indexOf('ov:b1') < ids.indexOf('ov:g1'));
  assert.ok(!ids.includes('wl:Rank.jpg'), 'imagem do artigo exato não entra na frente');
});
