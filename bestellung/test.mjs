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
// Die Tests laufen zu jeder Uhrzeit; die Öffnungszeiten prüft ein eigener Test weiter unten
await s.db.exec('update einstellungen set immer_offen = true');

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
  assert.deepEqual(fest, { ok: true, wahl: false, aktiv: true, offen: true, ausverkauft: [], bewertung_url: '', tisch: '1', bereich: 'Drinnen' });
  const laden = await rpc('tisch_info', { p_code: ladenCode });
  assert.equal(laden.wahl, true);
  assert.equal(laden.tische.length, 2);
  assert.equal(laden.tische[0].code, undefined, 'Tisch-Codes dürfen beim Gast nicht ankommen');
  assert.deepEqual(laden.ausverkauft, []);
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
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [bestellId] }), [{ id: bestellId, status: 'neu', bezahlt: false }]);
  assert.equal((await rpc('theke_status', { p_key: K, p_id: bestellId, p_status: 'angenommen' })).ok, true);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [bestellId] }), [{ id: bestellId, status: 'angenommen', bezahlt: false }]);
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

test('Bezahlen: Gast meldet sich, Theke rechnet den Tisch ab', async () => {
  // Tisch 2 hat noch nichts bestellt: kein Zahlwunsch möglich
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  assert.equal((await rpc('zahlen_wuenschen', { p_code: t2.code })).fehler, 'nichts');
  assert.equal((await rpc('zahlen_wuenschen', { p_code: 'falsch' })).fehler, 'tisch');
  // Tisch 1 hat 4 offene Bestellungen: 1370 + 3 x 290
  assert.equal((await rpc('zahlen_wuenschen', { p_code: tischCode })).ok, true);
  let t = await rpc('theke_bestellungen', { p_key: K });
  assert.equal(t.zahlen.length, 1);
  assert.equal(t.zahlen[0].tisch_id, tischId);
  assert.equal(t.bestellungen.filter(b => b.tisch_id === tischId && !b.bezahlt_at).length, 4);
  assert.equal((await rpc('theke_bezahlt', { p_key: 'falsch', p_tisch: tischId })).fehler, 'key');
  const r = await rpc('theke_bezahlt', { p_key: K, p_tisch: tischId });
  assert.equal(r.ok, true); assert.equal(r.rest, false); assert.equal(r.summe_cent, 1370 + 3 * 290);
  t = await rpc('theke_bestellungen', { p_key: K });
  assert.equal(t.zahlen.length, 0);
  assert.equal(t.bestellungen.filter(b => !b.bezahlt_at).length, 0);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [bestellId] }), [{ id: bestellId, status: 'serviert', bezahlt: true }]);
  // zweites Abrechnen findet nichts mehr
  assert.equal((await rpc('theke_bezahlt', { p_key: K, p_tisch: tischId })).summe_cent, 0);
});

test('Aufräumen: alte bezahlte Bestellungen werden gelöscht', async () => {
  await s.db.exec("update bestellungen set created_at = now() - interval '4 days' where nr = 1");
  await s.db.exec('select _aufraeumen()');
  assert.equal((await s.db.query('select count(*)::int as n from bestellungen')).rows[0].n, 3);
});

test('Getrennt zahlen: erst ein Teil, dann der Rest', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  const b = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [
    { name: 'Cappuccino', menge: 3, extras: [{ name: 'Sahne' }] }, { name: 'Espresso', menge: 1 }] });
  assert.equal(b.summe_cent, 3 * (390 + 80) + 290);
  // zwei der drei Cappuccino zahlen; mehr als vorhanden wird gekappt
  let r = await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id, p_auswahl: [{ id: b.id, pos: 0, menge: 2 }] });
  assert.equal(r.summe_cent, 2 * 470); assert.equal(r.rest, true);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [b.id] }), [{ id: b.id, status: 'neu', bezahlt: false }]);
  r = await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id, p_auswahl: [{ id: b.id, pos: 0, menge: 9 }] });
  assert.equal(r.summe_cent, 470); assert.equal(r.rest, true);
  // der Rest in einem Rutsch
  r = await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id });
  assert.equal(r.summe_cent, 290); assert.equal(r.rest, false);
  assert.deepEqual(await rpc('bestellung_status', { p_ids: [b.id] }), [{ id: b.id, status: 'serviert', bezahlt: true }]);
  assert.equal((await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id, p_auswahl: 'x' })).fehler, 'ungueltig');
});

test('Kellner rufen', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  assert.equal((await rpc('kellner_rufen', { p_code: 'falsch' })).fehler, 'tisch');
  assert.equal((await rpc('kellner_rufen', { p_code: ladenCode })).fehler, 'tisch', 'Laden-Code ohne Tisch');
  assert.equal((await rpc('kellner_rufen', { p_code: ladenCode, p_tisch: t2.id })).ok, true);
  let t = await rpc('theke_bestellungen', { p_key: K });
  assert.deepEqual(t.rufe.map(r => [r.tisch_id, r.tisch, r.bereich]), [[t2.id, '2', 'Drinnen']]);
  assert.equal((await rpc('theke_ruf_erledigt', { p_key: 'falsch', p_tisch: t2.id })).fehler, 'key');
  assert.equal((await rpc('theke_ruf_erledigt', { p_key: K, p_tisch: t2.id })).ok, true);
  t = await rpc('theke_bestellungen', { p_key: K });
  assert.equal(t.rufe.length, 0);
});

test('Ausverkauft: Artikel ist für heute gesperrt', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  assert.equal((await rpc('theke_ausverkauft', { p_key: 'falsch', p_name: 'Espresso', p_aus: true })).fehler, 'key');
  assert.equal((await rpc('theke_ausverkauft', { p_key: K, p_name: 'Espresso', p_aus: true })).ok, true);
  assert.deepEqual((await rpc('tisch_info', { p_code: t2.code })).ausverkauft, ['Espresso']);
  assert.equal((await rpc('theke_artikel', { p_key: K })).artikel.find(a => a.name === 'Espresso').aus, true);
  const r = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [{ name: 'Espresso', menge: 1 }] });
  assert.equal(r.fehler, 'ausverkauft'); assert.equal(r.artikel, 'Espresso');
  // gestern ausverkauft zählt heute nicht mehr
  await s.db.exec("update artikel set ausverkauft_am = current_date - 1 where name = 'Espresso'");
  assert.deepEqual((await rpc('tisch_info', { p_code: t2.code })).ausverkauft, []);
  assert.equal((await rpc('theke_ausverkauft', { p_key: K, p_name: 'Espresso', p_aus: false })).ok, true);
});

test('Einstellungen: Zeiten, Ruhetage, Bewertungslink, Tagesübersicht', async () => {
  let e = await rpc('theke_einstellungen', { p_key: K });
  assert.equal(e.zeiten.length, 7); assert.equal(e.zeiten[0].von, '10:00');
  assert.equal((await rpc('theke_zeiten_setzen', { p_key: K, p_zeiten: [{ tag: 1, von: '08:00', bis: '20:00' }] })).ok, true);
  assert.deepEqual((await rpc('theke_einstellungen', { p_key: K })).zeiten, [{ tag: 1, von: '08:00', bis: '20:00' }]);
  assert.equal((await rpc('theke_zeiten_setzen', { p_key: K, p_zeiten: [{ tag: 9, von: 'x', bis: 'y' }] })).fehler, 'ungueltig');
  assert.equal((await rpc('theke_einstellungen', { p_key: K })).zeiten.length, 1, 'ungültige Eingabe ändert nichts');
  await s.db.exec("delete from oeffnungszeiten; insert into oeffnungszeiten select g, '10:00', '18:00' from generate_series(1, 7) g");
  // Ruhetag heute: trotz Zeiten geschlossen
  const heute = (await s.db.query("select to_char((now() at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD') as d")).rows[0].d;
  await s.db.exec("update einstellungen set immer_offen = false; update oeffnungszeiten set von = '00:00', bis = '23:59:59'");
  assert.equal((await rpc('theke_einstellungen', { p_key: K })).offen, true);
  assert.equal((await rpc('theke_ruhetag', { p_key: K, p_datum: heute, p_an: true })).ok, true);
  e = await rpc('theke_einstellungen', { p_key: K });
  assert.equal(e.offen, false); assert.deepEqual(e.ruhetage, [heute]);
  await rpc('theke_ruhetag', { p_key: K, p_datum: heute, p_an: false });
  await s.db.exec('update einstellungen set immer_offen = true');
  // Bewertungslink
  assert.equal((await rpc('theke_bewertung', { p_key: K, p_url: 'javascript:alert(1)' })).fehler, 'ungueltig');
  assert.equal((await rpc('theke_bewertung', { p_key: K, p_url: 'https://g.page/r/abc/review' })).ok, true);
  assert.equal((await rpc('tisch_info', { p_code: ladenCode })).bewertung_url, 'https://g.page/r/abc/review');
  // Tagesübersicht
  const tag = await rpc('theke_tag', { p_key: K });
  assert.equal(tag.ok, true); assert.ok(tag.anzahl >= 2); assert.ok(tag.umsatz_cent > 0);
  assert.ok(tag.top.some(x => x.name === 'Cappuccino'));
});

test('Öffnungszeiten: außerhalb wird nicht bestellt', async () => {
  const b = () => rpc('bestellung_aufgeben', { p_code: t2Code, p_positionen: [{ name: 'Espresso', menge: 1 }] });
  const t2Code = (await rpc('theke_tische', { p_key: K })).tische[1].code;
  // heute geschlossen
  await s.db.exec("update einstellungen set immer_offen = false; update oeffnungszeiten set von = '00:00', bis = '00:00'");
  assert.equal((await rpc('tisch_info', { p_code: t2Code })).offen, false);
  assert.equal((await b()).fehler, 'geschlossen');
  // heute den ganzen Tag geöffnet
  await s.db.exec("update oeffnungszeiten set von = '00:00', bis = '23:59:59'");
  assert.equal((await rpc('tisch_info', { p_code: t2Code })).offen, true);
  assert.equal((await b()).ok, true);
  await s.db.exec('update einstellungen set immer_offen = true');
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
  assert.equal(t.bestellungen.length, 5);
  assert.equal(t.bestellungen[0].tisch, '1');
});
