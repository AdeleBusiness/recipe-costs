import HTML from './index.html';

const FS = 'https://api-prod.prod.fsniwaikato.kiwi/prod';
const BANNER = { pns: 'PNS', nw: 'MNW' };
const UA = 'okhttp/4.12.0';
const COLS = ['recipes', 'prices', 'settings'];
const LIVE = false; // supermarket feeds switched off: no permitted source yet

const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rid = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join(''); };

/* ---------- Foodstuffs (Pak'nSave / New World) ---------- */
async function token(env, chain) {
  const k = 'tok:' + chain, c = await env.KV.get(k);
  if (c) return c;
  const r = await fetch(FS + '/mobile/user/login/guest', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ banner: BANNER[chain] }) });
  if (!r.ok) throw new Error('Supermarket login failed (' + r.status + ')');
  const js = await r.json();
  await env.KV.put(k, js.access_token, { expirationTtl: Math.max(60, Math.min(3000, (js.expires_in || 1800) - 120)) });
  return js.access_token;
}
async function fs(env, chain, path, opt = {}) {
  const tok = await token(env, chain);
  const r = await fetch(FS + path, { ...opt, headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA, authorization: 'Bearer ' + tok, access_token: tok } });
  if (r.status === 401 || r.status === 403) await env.KV.delete('tok:' + chain);
  if (!r.ok) throw new Error('Supermarket answered ' + r.status);
  return r.json();
}
async function stores(env, chain) {
  const k = 'stores:' + chain, c = await env.KV.get(k);
  if (c) return JSON.parse(c);
  const arr = await fs(env, chain, '/mobile//store/physical');
  const out = (Array.isArray(arr) ? arr : []).filter(s => s.physicalActive !== false && s.id && s.name)
    .map(s => ({ id: s.id, name: s.name, lat: s.latitude, lng: s.longitude })).sort((a, b) => a.name.localeCompare(b.name));
  if (out.length) await env.KV.put(k, JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return out;
}
function size(units, saleType) {
  const u = String(units || '').toLowerCase().replace(/\s+/g, '');
  if (saleType === 'WEIGHT' || u === 'kg' || u === '1kg') return { size: 1000, base: 'g' };
  let m = u.match(/^(\d+)x(\d+(?:\.\d+)?)(g|kg|ml|l)$/);
  if (m) { const n = +m[1] * +m[2]; return m[3] === 'kg' ? { size: n * 1000, base: 'g' } : m[3] === 'l' ? { size: n * 1000, base: 'ml' } : { size: n, base: m[3] }; }
  m = u.match(/^(\d+(?:\.\d+)?)(g|kg|ml|l)$/);
  if (m) { const n = +m[1]; return m[2] === 'kg' ? { size: n * 1000, base: 'g' } : m[2] === 'l' ? { size: n * 1000, base: 'ml' } : { size: n, base: m[2] }; }
  m = u.match(/^(\d+)(ea|pk|pack|s)?$/);
  if (m) return { size: +m[1], base: 'ea' };
  return { size: 1, base: 'ea' };
}
function qty(t) {
  const m = String(t || '').toLowerCase().replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l|litres?)\b/);
  if (!m) { const n = String(t || '').match(/(\d+)\s*(pk|pack|x|ea|eggs|pieces)?/i); return n ? { size: +n[1], base: 'ea' } : { size: 1, base: 'ea' }; }
  const n = +m[1], u = m[2];
  return u === 'kg' ? { size: n * 1000, base: 'g' } : u === 'g' ? { size: n, base: 'g' } : u === 'ml' ? { size: n, base: 'ml' } : u === 'cl' ? { size: n * 10, base: 'ml' } : { size: n * 1000, base: 'ml' };
}
async function search(env, chain, store, q) {
  const js = await fs(env, chain, `/mobile/ecomm-products/${BANNER[chain]}/${store}/search?q=${encodeURIComponent(q)}`, { method: 'POST', body: '[]' });
  return (js.products || []).slice(0, 24).map(p => {
    const s = size(p.units, p.saleType);
    const deal = p.decalImageUrl ? decodeURIComponent((p.decalImageUrl.split('/').pop() || '').replace(/\.\w+$/, '')).replace(/_/g, ' ') : '';
    const im = p.productImageUrls || {};
    return { pid: p.productId, name: [p.brand, p.name].filter(Boolean).join(' '), units: p.units || '', price: (p.price || 0) / 100, unitPrice: p.unitPrice || '', img: im['200'] || im['100'] || '', deal, size: s.size, base: s.base, weight: p.saleType === 'WEIGHT' };
  });
}
/* refresh linked live prices inside price docs; returns changed docs */
async function refreshDocs(env, docs, max) {
  const jobs = [];
  for (const d of docs) for (const ch of ['pns', 'nw']) { const e = d.data[ch]; if (e && e.live && e.pid && e.store && e.pname) jobs.push({ d, ch, e }); }
  jobs.sort((a, b) => (a.e.updated || 0) - (b.e.updated || 0));
  const changed = new Set();
  for (const j of jobs.slice(0, max)) {
    try {
      const res = await search(env, j.ch, j.e.store, j.e.pname);
      const hit = res.find(r => r.pid === j.e.pid);
      if (hit) Object.assign(j.e, { price: hit.price, size: hit.size, base: hit.base, deal: hit.deal, img: hit.img || j.e.img, missing: false });
      else j.e.missing = true;
      j.e.updated = Date.now();
      changed.add(j.d);
    } catch (err) { break; }
  }
  return [...changed];
}

/* ---------- Stats NZ open data: Food Price Index weighted average prices (CC BY 4.0) ---------- */
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const statsUrl = (y, m) => { const M = MONTHS[m]; const C = M[0].toUpperCase() + M.slice(1); return `https://www.stats.govt.nz/assets/Uploads/Selected-price-indexes/Selected-price-indexes-${C}-${y}/Download-data/selected-price-indexes-${M}-${y}.csv`; };
const csvRow = l => { const o = []; let i = 0; while (i < l.length) { if (l[i] === '"') { const j = l.indexOf('"', i + 1); o.push(l.slice(i + 1, j)); i = j + 2; } else { let j = l.indexOf(',', i); if (j < 0) j = l.length; o.push(l.slice(i, j)); i = j + 1; } } return o; };
function statsSize(title) {
  const t = title.toLowerCase();
  let m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|litres?|l)\b(?!.*\d+(?:\.\d+)?\s*(kg|g|ml|litres?|l)\b)/);
  let size = 1, base = 'ea';
  if (m) { const n = +m[1], u = m[2]; if (u === 'kg') { size = n * 1000; base = 'g'; } else if (u === 'g') { size = n; base = 'g'; } else if (u === 'ml') { size = n; base = 'ml'; } else { size = n * 1000; base = 'ml'; } }
  if (/dozen/.test(t)) { size = 12; base = 'ea'; }
  if (/^grapes/.test(t) && base === 'ea') { size = 1000; base = 'g'; }
  m = t.match(/(?:pk of|box of|multipack,?)\s*(\d+)|(\d+)\s*pack/); if (m && !/\d+\s*(g|kg|ml|litre)/.test(t.split(',').pop())) { size = +(m[1] || m[2]); base = 'ea'; }
  if (/pk of (\d+)/.test(t)) { const k = +t.match(/pk of (\d+)/)[1]; if (base !== 'ea') size = size * k; }
  return { size, base };
}
async function refreshStats(env) {
  const cur = JSON.parse(await env.KV.get('statsnz') || 'null');
  const now = new Date();
  for (let back = 1; back <= 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const period = d.getUTCFullYear() + '.' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (cur && cur.period >= period) return cur;
    const r = await fetch(statsUrl(d.getUTCFullYear(), d.getUTCMonth()), { headers: { 'user-agent': 'RecipeCosts/1.0 (household recipe app; open data)' } });
    if (!r.ok) continue;
    const t = await r.text(), items = [];
    for (const l of t.split('\n')) {
      if (l.indexOf('Weighted Average Prices') < 0 || l.indexOf('"' + period + '"') < 0) continue;
      const c = csvRow(l), price = +c[2]; if (!(price > 0)) continue;
      items.push({ id: c[0].replace('CPIM.', ''), title: c[7], price, ...statsSize(c[7]) });
    }
    if (items.length > 20) { const v = { period, updated: Date.now(), source: 'Stats NZ, Food Price Index selected weighted average prices (CC BY 4.0)', items }; await env.KV.put('statsnz', JSON.stringify(v)); return v; }
  }
  return cur;
}

/* ---------- recipe import ---------- */
const txt = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&rsquo;|&lsquo;|&apos;/g, "'").replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾').replace(/&nbsp;/g, ' ').replace(/&deg;/g, '°').replace(/\s+/g, ' ').trim();
async function importRecipe(url) {
  let u; try { u = new URL(url); } catch (e) { throw new Error('That doesn’t look like a web link'); }
  const r = await fetch(u.href, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-NZ,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error('The recipe site wouldn’t open (' + r.status + '). Paste the recipe text instead.');
  const html = await r.text();
  let rec = null;
  const find = o => { if (!o || rec) return; if (Array.isArray(o)) return o.forEach(find); if (typeof o !== 'object') return; const t = o['@type']; if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) { rec = o; return; } if (o['@graph']) find(o['@graph']); if (o.mainEntity) find(o.mainEntity); };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { find(JSON.parse(m[1].trim())); } catch (e) { } if (rec) break; }
  if (!rec) throw new Error('That page has no recipe data the app can read. Paste the recipe text instead.');
  const img = Array.isArray(rec.image) ? rec.image[0] : rec.image;
  let image = typeof img === 'string' ? img : (img && img.url) || '';
  if (image) try { image = new URL(image, u.href).href; } catch (e) { image = ''; }
  const steps = [];
  const walk = x => { if (!x) return; if (typeof x === 'string') { x.split(/\n+/).forEach(s => { s = txt(s); if (s) steps.push(s); }); return; } if (Array.isArray(x)) return x.forEach(walk); if (x.itemListElement) return walk(x.itemListElement); if (x.text) steps.push(txt(x.text)); else if (x.name) steps.push(txt(x.name)); };
  walk(rec.recipeInstructions);
  const y = Array.isArray(rec.recipeYield) ? rec.recipeYield.join(' ') : String(rec.recipeYield || '');
  return { title: txt(rec.name).slice(0, 120) || 'Untitled recipe', servings: +((y.match(/\d+/) || [])[0]) || 4, image, ingredients: (Array.isArray(rec.recipeIngredient) ? rec.recipeIngredient : []).map(txt).filter(Boolean), method: steps.slice(0, 40), source: u.href };
}

/* ---------- household data ---------- */
async function hhOk(env, hh) { return !!(hh && /^[a-z0-9]{8,32}$/.test(hh) && await env.DB.prepare('SELECT 1 FROM households WHERE id=?').bind(hh).first()); }
async function all(env, hh) {
  const { results } = await env.DB.prepare('SELECT col,id,data FROM docs WHERE hh=?').bind(hh).all();
  const o = { recipes: {}, prices: {}, settings: {} };
  for (const r of results) if (o[r.col]) try { o[r.col][r.id] = JSON.parse(r.data); } catch (e) { }
  return o;
}
const putStmt = (env, hh, col, id, data) => env.DB.prepare('INSERT INTO docs(hh,col,id,data,updated) VALUES(?,?,?,?,?) ON CONFLICT(hh,col,id) DO UPDATE SET data=excluded.data,updated=excluded.updated').bind(hh, col, id, JSON.stringify(data), Date.now());

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === '/' || p === '/index.html') return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
      if (p === '/manifest.json') return J({ name: 'Recipe Costs', short_name: 'Recipe Costs', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#2f5d50', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });
      if (p === '/icon.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f5d50"/><path d="M28 22h44v58l-7-5-7 5-7-5-7 5-7-5-7 5z" fill="#fff"/><text x="50" y="62" font-family="Arial" font-weight="700" font-size="30" text-anchor="middle" fill="#cf3a20">$</text></svg>', { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public,max-age=86400' } });
      if (p === '/api/hh' && req.method === 'POST') { const id = rid(12); await env.DB.prepare('INSERT INTO households(id,created) VALUES(?,?)').bind(id, Date.now()).run(); return J({ id }); }
      if (!LIVE && (p === '/api/stores' || p === '/api/search' || /\/refresh$/.test(p))) return J({ error: 'Live supermarket prices are switched off' }, 410);
      if (p === '/api/stores') { const ch = url.searchParams.get('chain'); if (!BANNER[ch]) return J({ error: 'Unknown chain' }, 400); return J(await stores(env, ch)); }
      if (p === '/api/search') {
        const ch = url.searchParams.get('chain'), st = url.searchParams.get('store'), q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (!BANNER[ch] || !/^[0-9a-f-]{36}$/.test(st || '') || !q) return J({ error: 'Choose a store and search term' }, 400);
        return J(await search(env, ch, st, q));
      }
      if (p === '/api/statsnz') { let v = JSON.parse(await env.KV.get('statsnz') || 'null'); if (!v) v = await refreshStats(env); return J(v || { items: [] }); }
      const bc = p.match(/^\/api\/barcode\/(\d{6,14})$/);
      if (bc) {
        const k = 'bc:' + bc[1], c = await env.KV.get(k);
        if (c) return J(JSON.parse(c));
        const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${bc[1]}.json?fields=product_name,generic_name,quantity,brands`, { headers: { 'user-agent': 'RecipeCosts/1.0 (https://recipe-costs.recipecosts-nz.workers.dev)' } });
        if (!r.ok && r.status !== 404) return J({ error: 'Product lookup failed (' + r.status + ')' }, 502);
        const js = await r.json().catch(() => ({}));
        const pr = js.product || {};
        const q = String(pr.quantity || '').toLowerCase().replace(/\s+/g, '');
        const out = { found: js.status === 1 && !!(pr.product_name || pr.generic_name), code: bc[1], name: pr.product_name || '', generic: pr.generic_name || '', brand: (pr.brands || '').split(',')[0], quantity: pr.quantity || '', ...qty(pr.quantity) };
        await env.KV.put(k, JSON.stringify(out), { expirationTtl: 30 * 86400 });
        return J(out);
      }
      if (p === '/api/import' && req.method === 'POST') { const b = await req.json(); return J(await importRecipe(String(b.url || ''))); }
      const m = p.match(/^\/api\/hh\/([a-z0-9]+)\/(all|doc|refresh)(?:\/([a-z]+)\/(.+))?$/);
      if (m) {
        const [, hh, op, col, rawId] = m;
        if (!await hhOk(env, hh)) return J({ error: 'Household not found' }, 404);
        if (op === 'all') return J(await all(env, hh));
        if (op === 'doc') {
          const id = decodeURIComponent(rawId || '');
          if (!COLS.includes(col) || !id || id.length > 100) return J({ error: 'Bad path' }, 400);
          if (req.method === 'PUT') { const body = await req.text(); if (body.length > 200000) return J({ error: 'Too large' }, 413); JSON.parse(body); await putStmt(env, hh, col, id, JSON.parse(body)).run(); return J({ ok: true }); }
          if (req.method === 'DELETE') { await env.DB.prepare('DELETE FROM docs WHERE hh=? AND col=? AND id=?').bind(hh, col, id).run(); return J({ ok: true }); }
        }
        if (op === 'refresh' && req.method === 'POST') {
          const b = await req.json(), keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 60);
          if (!keys.length) return J({ prices: {} });
          const rows = (await env.DB.prepare(`SELECT id,data FROM docs WHERE hh=? AND col='prices' AND id IN (${keys.map(() => '?').join(',')})`).bind(hh, ...keys).all()).results;
          const docs = rows.map(r => ({ id: r.id, data: JSON.parse(r.data) }));
          const changed = await refreshDocs(env, docs, 12);
          if (changed.length) await env.DB.batch(changed.map(d => putStmt(env, hh, 'prices', d.id, d.data)));
          const out = {}; for (const d of docs) out[d.id] = d.data;
          return J({ prices: out, refreshed: changed.length });
        }
      }
      return J({ error: 'Not found' }, 404);
    } catch (e) { return J({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(evt, env) {
    if (new Date().getUTCHours() === 20) { try { await refreshStats(env); } catch (e) { } }
    if (!LIVE) return;
    const cut = Date.now() - 20 * 3600 * 1000;
    const rows = (await env.DB.prepare("SELECT hh,id,data FROM docs WHERE col='prices' LIMIT 3000").all()).results;
    const docs = [];
    for (const r of rows) { let d; try { d = JSON.parse(r.data); } catch (e) { continue; } if (['pns', 'nw'].some(ch => d[ch] && d[ch].live && (d[ch].updated || 0) < cut)) docs.push({ hh: r.hh, id: r.id, data: d }); }
    if (!docs.length) return;
    const changed = await refreshDocs(env, docs, 15);
    if (changed.length) await env.DB.batch(changed.map(d => putStmt(env, d.hh, 'prices', d.id, d.data)));
  }
};
