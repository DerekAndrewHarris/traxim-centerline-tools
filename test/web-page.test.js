/**
 * Web page helpers in osm-workflow.js (October 2026): the warning groups
 * (important warnings never hidden) and the recent network names list.
 *
 * osm-workflow.js is a plain browser script, so it is loaded here into a
 * small stand-in browser (node:vm) with just enough of Leaflet and the
 * document for its top level to run; its functions are then called directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

function loadPage({ storage = 'ok' } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => { if (storage === 'broken') throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (storage === 'broken') throw new Error('SecurityError'); store.set(k, String(v)); }
  };
  const elements = new Map();
  const document = {
    addEventListener() {},
    getElementById: (id) => elements.get(id) || null,
    createElement: () => ({ value: '' })
  };
  const datalist = { children: [], set innerHTML(v) { this.children = []; }, appendChild(o) { this.children.push(o); } };
  elements.set('recentNetworkNames', datalist);
  const window = { localStorage };
  const context = vm.createContext({
    window, document, console, localStorage,
    L: { layerGroup: () => ({}) },
    setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(new URL('../osm-workflow.js', import.meta.url), 'utf-8'), context);
  return { page: context, store, datalist };
}

test('recent names: newest first, at most 6, no duplicates ignoring capitals', () => {
  const { page } = loadPage();
  let list = [];
  for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) list = page.addRecentName(list, n);
  assert.deepEqual([...list], ['F', 'E', 'D', 'C', 'B', 'A']);
  list = page.addRecentName(list, 'G');
  assert.deepEqual([...list], ['G', 'F', 'E', 'D', 'C', 'B'], 'oldest drops off');
  list = page.addRecentName(list, 'd');
  assert.deepEqual([...list], ['d', 'G', 'F', 'E', 'C', 'B'], 'used again: moves to the top, once');
  assert.deepEqual([...page.addRecentName(list, '   ')], [...list], 'blank name not added');
});

test('recent names are kept in localStorage and shown in the dropdown', () => {
  const { page, store, datalist } = loadPage();
  page.rememberNetworkName('Ligurian coast');
  page.rememberNetworkName('Tuscany');
  page.rememberNetworkName('ligurian coast ');
  assert.deepEqual(JSON.parse(store.get('traxim.fileGenerator.recentNetworkNames')), ['ligurian coast', 'Tuscany']);
  assert.deepEqual(datalist.children.map(o => o.value), ['ligurian coast', 'Tuscany']);
});

test('recent names still work when storage is unavailable', () => {
  const { page, datalist } = loadPage({ storage: 'broken' });
  page.rememberNetworkName('One');
  page.rememberNetworkName('Two');
  assert.deepEqual([...page.loadRecentNetworkNames()], ['Two', 'One']);
  assert.deepEqual(datalist.children.map(o => o.value), ['Two', 'One']);
});

test('warnings: serious and "check these" shown in full, information behind "show all"', () => {
  const { page } = loadPage();
  const review = Array.from({ length: 40 }, (_, i) => `PLATFORMS MERGED at 44.${i}, 9.8: <check>`);
  const html = page.warningGroupsHtml({ serious: ['Platform fetch failed: x'], review, info: ['Fetched 3 ways', 'Loaded 2 cached'] });
  for (let i = 0; i < 40; i++) assert.ok(html.includes(`PLATFORMS MERGED at 44.${i}, 9.8: &lt;check&gt;`), `review warning ${i} shown, escaped`);
  assert.ok(!/more warnings/.test(html), 'nothing cut off');
  assert.match(html, /Platform fetch failed/);
  const details = html.slice(html.indexOf('<details'));
  assert.ok(details.includes('Fetched 3 ways') && details.includes('Loaded 2 cached'), 'information notes in the collapsible list');
  assert.ok(!html.slice(0, html.indexOf('<details')).includes('Fetched 3 ways'), 'information notes not in the open part');
  // An older server's plain list: everything shown.
  assert.match(page.warningGroupsHtml(null, ['a', 'b']), /a<\/li>.*b<\/li>/s);
});
