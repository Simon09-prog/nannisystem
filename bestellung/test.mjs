// Spielt den ganzen Ablauf einmal durch: Tisch anlegen, bestellen, annehmen, servieren.
// Aufruf: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './dev-server.mjs';

const s = await start({ port: 0, memory: true });
const K = s.thekeKey;
// wie der Browser: echter HTTP-Aufruf an /rest/v1/rpc/...
const rpc = async (fn, args = {}) => (await fetch(`${s.basis}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })).json();
test.after(() => s.stop());

let tischCode, tischId, ladenCode, bestellId;

test('Theke: ohne gültigen Schlüssel geht nichts', async () => {
  for (const fn of ['theke_bestellungen', 'theke_tische', 'theke_laden_code_neu'])
    assert.deepEqual(await rpc(fn, { p_key: 'falsch' }), { ok: false, fehler: 'key' });
  assert.equal((await rpc('theke_tisch_anlegen', { p_key: 'falsch', p_name: '1' })).fehler, 'key');
});

test('Interne Funktionen sind von außen nicht erreichbar', async () => {
  const res = await fetch(`${s.basis}/rest/v1/rpc/theke_schluessel_neu`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
});

test('Theke: Tische anlegen, doppelte werden abgelehnt', async () => {
  assert.equal((await rpc('theke_tisch_anlegen', { p_key: K, p_name: '1', p_bereich: 'Drinnen' })).ok, true);
  assert.equal((await rpc('theke_tisch_anlegen', { p_key: K, p_name: '2', p_bereich: 'Drinnen' })).ok, true);
  assert.equal((await rpc('theke_tisch_anlegen', { p_key: K, p_name: '1', p_bereich: 'Drinnen' })).fehler, 'doppelt');
  const t = await rpc('theke_tische', { p_key: K });
  assert.equal(t.tische.length, 2);
  ({ code: tischCode, id: tischId } = t.tische[0]);
  ladenCode = t.laden_code;
});

test('Gast: Link-Arten', async () => {
  assert.deepEqual(await rpc('tisch_info', { p_code: 'gibtsnicht' }), { ok: false });
  const fest = await rpc('tisch_info', { p_code: tischCode });
  assert.deepEqual(fest, { ok: true, wahl: false, aktiv: true, tisch: '1', bereich: 'Drinnen' });
  const laden = await rpc('tisch_info', { p_code: ladenCode });
  assert.equal(laden.wahl, true);
  assert.equal(laden.tische.length, 2);
  assert.equal(laden.tische[0].code, undefined, 'Tisch-Codes dürfen beim Gast nicht ankommen');
});

test('Gast: bestellen, der Server rechnet mit seinen eigenen Preisen', async () => {
  const res = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [
    { name: 'Cappuccino', menge: 2, preis_cent: 1, notiz: ' Hafermilch ', extras: [{ name: 'Extra Espresso Shot', preis_cent: 0 }] },
    { name: 'Espresso', menge: 1, extras: [] }] });
  assert.equal(res.ok, true);
  assert.equal(res.nr, 1);
  assert.equal(res.summe_cent, (390 + 150) * 2 + 290);
  bestellId = res.id;
});

test('Gast: Unsinn wird abgelehnt', async () => {
  const b = pos => rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: pos });
  assert.equal((await b([{ name: 'Gratis-Champagner', menge: 1 }])).fehler, 'artikel');
  assert.equal((await b([{ name: 'Espresso', menge: 1, extras: [{ name: 'Burrata' }] }])).fehler, 'artikel', 'Extra passt nicht zur Kategorie');
  assert.equal((await b([{ name: 'Espresso', menge: 0 }])).fehler, 'ungueltig');
  assert.equal((await b([{ name: 'Espresso', menge: -5 }])).fehler, 'ungueltig');
  assert.equal((await b([{ name: 'Espresso', menge: 'viele' }])).fehler, 'ungueltig');
  assert.equal((await b([])).fehler, 'ungueltig');
  assert.equal((await b('x')).fehler, 'ungueltig');
  assert.equal((await rpc('bestellung_aufgeben', { p_code: 'falsch', p_positionen: [{ name: 'Espresso', menge: 1 }] })).fehler, 'tisch');
  assert.equal((await rpc('bestellung_aufgeben', { p_code: ladenCode, p_positionen: [{ name: 'Espresso', menge: 1 }] })).fehler, 'tisch', 'Laden-Code ohne Tischwahl');
});

test('Theke: sieht die Bestellung, nimmt an, serviert; der Gast sieht den Stand', async () => {
  let t = await rpc('theke_bestellungen', { p_key: K });
  assert.equal(t.bestellungen.length, 1);
  const o = t.bestellungen[0];
  assert.equal(o.tisch, '1'); assert.equal(o.status, 'neu');
  assert.equal(o.positionen[0].notiz, 'Hafermilch');
  assert.deepEqual(o.positionen[0].extras, [{ name: 'Extra Espresso Shot', preis_cent: 150 }]);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [bestellId] }), [{ id: bestellId, status: 'neu' }]);
  assert.equal((await rpc('theke_status', { p_key: K, p_id: bestellId, p_status: 'angenommen' })).ok, true);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [bestellId] }), [{ id: bestellId, status: 'angenommen' }]);
  assert.equal((await rpc('theke_status', { p_key: K, p_id: bestellId, p_status: 'kaputt' })).fehler, 'status');
  assert.equal((await rpc('theke_status', { p_key: 'falsch', p_id: bestellId, p_status: 'serviert' })).fehler, 'key');
  assert.equal((await rpc('theke_status', { p_key: K, p_id: bestellId, p_status: 'serviert' })).ok, true);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [] }), []);
});

test('Bremse: höchstens 3 offene Bestellungen je Tisch, über den Laden-Code mit Tischwahl', async () => {
  const b = () => rpc('bestellung_aufgeben', { p_code: ladenCode, p_tisch: tischId, p_positionen: [{ name: 'Espresso', menge: 1 }] });
  for (let i = 0; i < 3; i++) assert.equal((await b()).ok, true);
  assert.equal((await b()).fehler, 'zuviele');
});

test('Pausieren und Codes erneuern', async () => {
  await rpc('theke_aktiv', { p_key: K, p_aktiv: false });
  assert.equal((await rpc('tisch_info', { p_code: tischCode })).aktiv, false);
  assert.equal((await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Espresso', menge: 1 }] })).fehler, 'pausiert');
  await rpc('theke_aktiv', { p_key: K, p_aktiv: true });
  await rpc('theke_tisch_neuer_code', { p_key: K, p_id: tischId });
  assert.deepEqual(await rpc('tisch_info', { p_code: tischCode }), { ok: false }, 'alter Tisch-Code gilt nicht mehr');
  await rpc('theke_laden_code_neu', { p_key: K });
  assert.deepEqual(await rpc('tisch_info', { p_code: ladenCode }), { ok: false }, 'alter Laden-Code gilt nicht mehr');
});

test('Tisch löschen: alte Bestellungen bleiben lesbar', async () => {
  assert.equal((await rpc('theke_tisch_loeschen', { p_key: K, p_id: tischId })).ok, true);
  const t = await rpc('theke_bestellungen', { p_key: K });
  assert.equal(t.bestellungen.length, 4);
  assert.equal(t.bestellungen[0].tisch, '1');
});
