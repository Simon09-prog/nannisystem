// Spielt den ganzen Ablauf einmal durch: Tisch anlegen, bestellen, annehmen, servieren.
// Aufruf: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './dev-server.mjs';

const s = await start({ port: 0, memory: true });
const K = s.thekeKey;
// wie der Browser: echter HTTP-Aufruf an /rest/v1/rpc/...
const roh = async (fn, args = {}) => (await fetch(`${s.basis}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })).json();
// Die Tests schicken absichtlich viele falsche Schlüssel. Damit dabei nicht die Sperre nach Fehlversuchen zuschlägt,
// werden die gezählten Fehlversuche vor jedem Aufruf gelöscht. Die Sperre selbst prüft ein eigener Test mit "roh".
const rpc = async (fn, args = {}) => { await s.db.exec("delete from zugriffe where was = 'login'"); return roh(fn, args); };
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
  assert.deepEqual(fest, { ok: true, wahl: false, aktiv: true, offen: true, lunch: true, ausverkauft: [], bewertung_url: '', tisch: '1', bereich: 'Drinnen' });
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
  assert.equal(o.positionen[0].getraenk, true);
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

test('Getränke zuerst servieren, dann das Essen', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  const b = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [{ name: 'Cappuccino', menge: 1 }, { name: 'Rührei Genuss', menge: 1 }] });
  const lesen = async () => (await rpc('theke_bestellungen', { p_key: K })).bestellungen.find(x => x.id === b.id);
  assert.equal((await rpc('theke_serviert', { p_key: 'falsch', p_ids: [b.id] })).fehler, 'key');
  assert.equal((await rpc('theke_serviert', { p_key: K, p_ids: [b.id], p_nur_getraenke: true })).ok, true);
  let o = await lesen();
  assert.equal(o.status, 'angenommen');
  assert.deepEqual(o.positionen.map(p => [p.name, !!p.serviert]), [['Cappuccino', true], ['Rührei Genuss', false]]);
  // zurück auf "in Arbeit" setzt die Häkchen zurück
  await rpc('theke_status', { p_key: K, p_id: b.id, p_status: 'angenommen' });
  assert.deepEqual((await lesen()).positionen.map(p => !!p.serviert), [false, false]);
  await rpc('theke_serviert', { p_key: K, p_ids: [b.id], p_nur_getraenke: true });
  await rpc('theke_serviert', { p_key: K, p_ids: [b.id] });
  o = await lesen();
  assert.equal(o.status, 'serviert');
  assert.deepEqual(o.positionen.map(p => !!p.serviert), [true, true]);
  await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id });
});

test('Bestellung zurückziehen: nur solange sie nicht angenommen ist', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  const a = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [{ name: 'Americano', menge: 1 }] });
  const b = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [{ name: 'Americano', menge: 2 }] });
  assert.equal((await rpc('bestellung_zurueckziehen', { p_id: a.id })).ok, true);
  assert.equal((await rpc('bestellung_zurueckziehen', { p_id: a.id })).fehler, 'weg');
  // die nächste Bestellung bekommt keine Nummer doppelt
  const c = await rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: [{ name: 'Americano', menge: 1 }] });
  assert.ok(c.nr > b.nr);
  await rpc('theke_status', { p_key: K, p_id: b.id, p_status: 'angenommen' });
  assert.equal((await rpc('bestellung_zurueckziehen', { p_id: b.id })).fehler, 'zu_spaet');
  await rpc('theke_bezahlt', { p_key: K, p_tisch: t2.id });
});

test('Tische öffnen: Annehmen öffnet, Bezahlen schließt, ein Nein sperrt nicht', async () => {
  await rpc('theke_tisch_anlegen', { p_key: K, p_name: '9', p_bereich: 'Drinnen' });
  const t9 = (await rpc('theke_tische', { p_key: K })).tische.find(t => t.name === '9');
  const offen = async () => (await rpc('theke_bestellungen', { p_key: K })).tische_offen.includes(t9.id);
  const b = () => rpc('bestellung_aufgeben', { p_code: t9.code, p_positionen: [{ name: 'Americano', menge: 1 }] });
  // geschlossener Tisch, Theke sagt Nein: der Tisch bleibt zu, es gibt aber keine Zeitsperre
  const a = await b();
  assert.equal(await offen(), false);
  await rpc('theke_status', { p_key: K, p_id: a.id, p_status: 'abgelehnt' });
  assert.equal(await offen(), false);
  assert.equal((await rpc('kellner_rufen', { p_code: t9.code })).ok, true);
  const a2 = await b();
  assert.equal(a2.ok, true);
  // Annehmen öffnet den Tisch
  await rpc('theke_status', { p_key: K, p_id: a2.id, p_status: 'angenommen' });
  assert.equal(await offen(), true);
  // am offenen Tisch sperrt eine Ablehnung nicht
  const c = await b();
  await rpc('theke_status', { p_key: K, p_id: c.id, p_status: 'abgelehnt' });
  assert.equal((await b()).ok, true);
  // nach dem Bezahlen ist der Tisch wieder geschlossen
  await rpc('theke_bezahlt', { p_key: K, p_tisch: t9.id });
  assert.equal(await offen(), false);
  await rpc('theke_tisch_loeschen', { p_key: K, p_id: t9.id });
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
  assert.equal(e.zeiten.length, 6); assert.equal(e.zeiten[0].von, '09:00');   // Donnerstag ist Ruhetag
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

test('Bremse bei übermäßiger Nutzung', async () => {
  const b = async () => (await s.db.query("select _bremse('test', 2, 10) as ok")).rows[0].ok;
  assert.equal(await b(), true); assert.equal(await b(), true); assert.equal(await b(), false);
  // nach einem erledigten Ruf ist der Tisch eine Minute still
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  await s.db.exec('update tische set ruf_erledigt_at = null');   // ein früherer Test hat an diesem Tisch schon gerufen
  assert.equal((await rpc('kellner_rufen', { p_code: t2.code })).ok, true);
  await rpc('theke_ruf_erledigt', { p_key: K, p_tisch: t2.id });
  assert.equal((await rpc('kellner_rufen', { p_code: t2.code })).fehler, 'bremse');
  await s.db.exec('update tische set ruf_erledigt_at = null; delete from zugriffe');
});

test('Getrennte Zugänge: Theken-Schlüssel reicht nicht für die Einstellungen', async () => {
  assert.equal((await rpc('theke_einstellungen', { p_key: K })).chef_gesetzt, false);
  assert.equal((await rpc('schluessel_neu', { p_key: 'falsch', p_art: 'chef' })).fehler, 'key');
  const chef = (await rpc('schluessel_neu', { p_key: K, p_art: 'chef' })).schluessel;
  assert.equal(chef.length, 40);
  // Theke darf weiter Bestellungen sehen und Artikel sperren, aber keine Einstellungen mehr
  assert.equal((await rpc('theke_bestellungen', { p_key: K })).ok, true);
  assert.equal((await rpc('theke_artikel', { p_key: K })).ok, true);
  for (const fn of ['theke_einstellungen', 'theke_tag', 'theke_tische', 'theke_laden_code_neu'])
    assert.equal((await rpc(fn, { p_key: K })).fehler, 'key', fn);
  assert.equal((await rpc('schluessel_neu', { p_key: K, p_art: 'theke' })).fehler, 'key');
  // Chefin darf alles, auch die Theke
  assert.equal((await rpc('theke_einstellungen', { p_key: chef })).chef_gesetzt, true);
  assert.equal((await rpc('theke_bestellungen', { p_key: chef })).ok, true);
  // Theken-Schlüssel wechseln: der alte gilt nicht mehr
  const neu = (await rpc('schluessel_neu', { p_key: chef, p_art: 'theke' })).schluessel;
  assert.equal((await rpc('theke_bestellungen', { p_key: K })).fehler, 'key');
  assert.equal((await rpc('theke_bestellungen', { p_key: neu })).ok, true);
  // eigenes Passwort festlegen
  assert.equal((await rpc('schluessel_setzen', { p_key: neu, p_art: 'chef', p_neu: 'geheim123' })).fehler, 'key', 'Theke darf das nicht');
  assert.equal((await rpc('schluessel_setzen', { p_key: chef, p_art: 'chef', p_neu: 'kurz' })).fehler, 'kurz');
  assert.equal((await rpc('schluessel_setzen', { p_key: chef, p_art: 'chef', p_neu: 'Mein eigenes Passwort' })).ok, true);
  assert.equal((await rpc('theke_einstellungen', { p_key: chef })).fehler, 'key');
  assert.equal((await rpc('theke_einstellungen', { p_key: 'Mein eigenes Passwort' })).ok, true);
  // Notfall-Weg: keine Funktion mehr (von außen nicht aufrufbar), nur ein direkter Eintrag im SQL-Editor
  assert.equal((await fetch(`${s.basis}/rest/v1/rpc/chef_passwort_setzen`, { method: 'POST', body: '{"p_neu":"hackerhacker"}' })).status, 404);
  assert.equal((await s.db.query("select count(*)::int as n from pg_proc where proname in ('chef_passwort_setzen', 'theke_passwort_setzen')")).rows[0].n, 0);
  await s.db.query("update einstellungen set chef_hash = sha256(convert_to('Notfall-Passwort 1', 'UTF8')) where id = 1");
  assert.equal((await rpc('theke_einstellungen', { p_key: 'Notfall-Passwort 1' })).ok, true);
  // für die übrigen Tests: alter Theken-Schlüssel wieder gültig, kein Chef-Schlüssel
  await s.db.query("update einstellungen set chef_hash = null, theke_hash = sha256(convert_to($1, 'UTF8'))", [K]);
});

test('Karte pflegen: Preis, Texte, ausblenden, neuer Artikel, Extras', async () => {
  const t2 = (await rpc('theke_tische', { p_key: K })).tische[1];
  const stand = async () => rpc('karte_stand');
  const b = pos => rpc('bestellung_aufgeben', { p_code: t2.code, p_positionen: pos });
  let s0 = await stand();
  assert.equal(s0.artikel.find(a => a.name === 'Espresso').preis_cent, 290);
  assert.ok(s0.artikel.find(a => a.name === 'Rührei Genuss').beschreibung.includes('Rührei'));
  assert.equal((await rpc('chef_artikel_speichern', { p_key: 'falsch', p_name: 'Espresso', p_daten: { preis_cent: 1 } })).fehler, 'key');
  assert.equal((await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Espresso', p_daten: { preis_cent: -5 } })).fehler, 'preis');
  assert.equal((await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Espresso', p_daten: { preis_cent: 'abc' } })).fehler, 'ungueltig');
  // Preis und Anzeigename ändern: Die Bestellung rechnet sofort mit dem neuen Preis und trägt den neuen Namen
  assert.equal((await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Espresso', p_daten: { preis_cent: 310, titel: 'Espresso Classico', name_en: 'Classic espresso' } })).ok, true);
  const o = await b([{ name: 'Espresso', menge: 2 }]);
  assert.equal(o.summe_cent, 620);
  const an = (await rpc('theke_bestellungen', { p_key: K })).bestellungen.find(x => x.id === o.id);
  assert.equal(an.positionen[0].name, 'Espresso Classico');
  // ausblenden: verschwindet aus der Karte und ist nicht bestellbar
  await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Americano', p_daten: { preis_cent: 350, versteckt: true } });
  assert.equal((await stand()).artikel.some(a => a.name === 'Americano'), false);
  assert.equal((await b([{ name: 'Americano', menge: 1 }])).fehler, 'artikel');
  assert.equal((await rpc('theke_artikel', { p_key: K })).artikel.some(a => a.name === 'Americano'), false);
  await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Americano', p_daten: { preis_cent: 350, versteckt: false } });
  // neuer Artikel
  assert.equal((await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Zimtschnecke', p_daten: { preis_cent: 420, kategorie: 'gibtsnicht' } })).fehler, 'kategorie');
  const neu = await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Zimtschnecke', p_daten: { preis_cent: 420, kategorie: 'sweets', beschreibung: 'Frisch gebacken.' } });
  assert.equal(neu.ok, true); assert.equal(neu.neu, true);
  const z = (await stand()).artikel.find(a => a.name === 'Zimtschnecke');
  assert.equal(z.eigen, true); assert.equal(z.kategorie, 'sweets');
  assert.equal((await b([{ name: 'Zimtschnecke', menge: 1 }])).summe_cent, 420);
  // Löschen nur bei eigenen Artikeln
  assert.equal((await rpc('chef_artikel_loeschen', { p_key: K, p_name: 'Cappuccino' })).fehler, 'fest');
  assert.equal((await rpc('chef_artikel_loeschen', { p_key: K, p_name: 'Zimtschnecke' })).ok, true);
  await s.db.exec("update bestellungen set status = 'abgelehnt' where status = 'neu'");   // sonst greift die Grenze von 3 offenen Bestellungen je Tisch
  // Extras
  assert.equal((await rpc('chef_extra_speichern', { p_key: K, p_kategorie: 'kaffee', p_name: 'Hafermilch Barista', p_preis_cent: 50 })).ok, true);
  assert.equal((await b([{ name: 'Cappuccino', menge: 1, extras: [{ name: 'Hafermilch Barista' }] }])).summe_cent, 440);
  assert.equal((await rpc('chef_extra_loeschen', { p_key: K, p_kategorie: 'kaffee', p_name: 'Hafermilch Barista' })).ok, true);
  // aufräumen für die übrigen Tests
  await rpc('chef_artikel_speichern', { p_key: K, p_name: 'Espresso', p_daten: { preis_cent: 290, titel: '', name_en: '' } });
  await s.db.exec("update bestellungen set status = 'abgelehnt' where status = 'neu'");
});

test('Sperre nach 10 falschen Passwörtern', async () => {
  await s.db.exec("delete from zugriffe where was = 'login'; delete from geraete");
  const mit = (key, geraet) => key + String.fromCharCode(31) + geraet;
  // Das Theken-Tablet meldet sich einmal richtig an und ist damit ein bekanntes Gerät
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'tablet') })).ok, true);
  // Ein Fremder probiert 10 falsche Passwörter
  for (let i = 0; i < 10; i++) assert.equal((await roh('theke_bestellungen', { p_key: mit('falsch' + i, 'fremd') })).fehler, 'key');
  // Jetzt ist gesperrt, selbst mit dem richtigen Passwort von einem unbekannten Gerät
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'fremd') })).fehler, 'gesperrt');
  assert.equal((await roh('theke_einstellungen', { p_key: K })).fehler, 'gesperrt', 'auch ohne Geräte-Kennung');
  // Das bekannte Tablet arbeitet ungestört weiter
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'tablet') })).ok, true);
  // Schickt das bekannte Tablet ein falsches Passwort, ist es nicht mehr bekannt und ebenfalls gesperrt
  assert.equal((await roh('theke_bestellungen', { p_key: mit('falsch', 'tablet') })).fehler, 'key');
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'tablet') })).fehler, 'gesperrt');
  // Nach 15 Minuten geht es wieder
  await s.db.exec("update zugriffe set fenster = fenster - interval '16 minutes' where was = 'login'");
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'tablet') })).ok, true);
  // Mit dem Theken-Passwort den Chef-Bereich zu öffnen zählt nicht als Fehlversuch (das passiert bei jedem Öffnen der Einstellungen)
  await s.db.query("update einstellungen set chef_hash = sha256(convert_to('chefchef1', 'UTF8')) where id = 1");
  for (let i = 0; i < 12; i++) assert.equal((await roh('theke_einstellungen', { p_key: mit(K, 'tablet') })).fehler, 'key');
  assert.equal((await roh('theke_bestellungen', { p_key: mit(K, 'neuesgeraet') })).ok, true);
  await s.db.exec("update einstellungen set chef_hash = null where id = 1; delete from zugriffe where was = 'login'");
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
  assert.ok(t.bestellungen.length >= 1);
  assert.equal(t.bestellungen[0].tisch, '1');
});

test('Lunch Deal: genau ein Getränk inklusive', async () => {
  const tischCode = (await rpc('theke_tische', { p_key: K })).tische.at(-1).code;   // die Codes von oben gelten nicht mehr
  const ohne = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Nannis Knusper-Rösti', menge: 1, extras: [] }] });
  assert.equal(ohne.fehler, 'ungueltig');
  const zwei = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Nannis Knusper-Rösti', menge: 1,
    extras: [{ name: 'Getränk: Cappuccino' }, { name: 'Getränk: Pfirsich-Limo' }] }] });
  assert.equal(zwei.fehler, 'ungueltig');
  const mit = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Nannis Knusper-Rösti', menge: 1, extras: [{ name: 'Getränk: Flat White' }] }] });
  assert.equal(mit.ok, true);
  assert.equal(mit.summe_cent, 1390);
});

test('Auswahl je Gericht: Milchsorte frei wählbar, Egg Drop mit genau einem Topping und einer Soße', async () => {
  const tischCode = (await rpc('theke_tische', { p_key: K })).tische.at(-1).code;
  await s.db.query("update bestellungen set status = 'serviert' where status = 'neu'");
  const bestellen = (name, extras) => rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name, menge: 1, extras: extras.map(name => ({ name })) }] });
  // Milch: ohne Wahl (= Kuhmilch) oder genau eine Sorte, ohne Aufpreis; nicht zwei Sorten, keine Milch beim Espresso
  assert.equal((await bestellen('Cappuccino', [])).ok, true);
  const hafer = await bestellen('Cappuccino', ['Milch: Hafermilch']);
  assert.equal(hafer.ok, true);
  assert.equal(hafer.summe_cent, 390);
  await s.db.query("update bestellungen set status = 'serviert' where status = 'neu'");
  assert.equal((await bestellen('Cappuccino', ['Milch: Hafermilch', 'Milch: Kokosmilch'])).fehler, 'ungueltig');
  assert.equal((await bestellen('Espresso', ['Milch: Hafermilch'])).fehler, 'artikel');
  assert.equal((await bestellen('Cappuccino', ['Milch: Sojamilch'])).fehler, 'artikel');
  // Egg Drop: Topping und Soße sind Pflicht, je genau eins, beides inklusive
  assert.equal((await bestellen('Nanni Egg Drop', [])).fehler, 'ungueltig');
  assert.equal((await bestellen('Nanni Egg Drop', ['Topping: Sucuk'])).fehler, 'ungueltig');
  assert.equal((await bestellen('Nanni Egg Drop', ['Topping: Sucuk', 'Topping: Bacon', 'Soße: Trüffelcreme'])).fehler, 'ungueltig');
  const egg = await bestellen('Nanni Egg Drop', ['Topping: Sucuk', 'Soße: Trüffelcreme']);
  assert.equal(egg.ok, true);
  assert.equal(egg.summe_cent, 1090);
  // Die Auswahl gilt nur für dieses Gericht, nicht für andere Shokupans
  assert.equal((await bestellen('Burrata Italia', ['Topping: Sucuk'])).fehler, 'artikel');
  // Kleine Pommes: genau ein Dip, inklusive
  await s.db.query("update bestellungen set status = 'serviert' where status = 'neu'");
  assert.equal((await bestellen('Kleine Süßkartoffel-Pommes + Dip', [])).fehler, 'ungueltig');
  const pommes = await bestellen('Kleine Süßkartoffel-Pommes + Dip', ['Dip: Ketchup']);
  assert.equal(pommes.ok, true);
  assert.equal(pommes.summe_cent, 390);
});

test('Lunch Deal außerhalb der Lunchzeit: dieselben Gerichte, aber ohne Getränk', async () => {
  const tischCode = (await rpc('theke_tische', { p_key: K })).tische.at(-1).code;
  await s.db.query("update bestellungen set status = 'serviert' where status = 'neu'");   // Platz für neue Bestellungen an diesem Tisch
  const vorher = (await s.db.query("select pg_get_functiondef('_lunchzeit'::regproc) as d")).rows[0].d;
  await s.db.query("create or replace function _lunchzeit() returns boolean language sql stable as $$ select false $$");
  try {
    assert.equal((await rpc('tisch_info', { p_code: tischCode })).lunch, false);
    const mitGetraenk = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Nannis Knusper-Rösti', menge: 1, extras: [{ name: 'Getränk: Flat White' }] }] });
    assert.equal(mitGetraenk.fehler, 'lunchzeit');
    const ohne = await rpc('bestellung_aufgeben', { p_code: tischCode, p_positionen: [{ name: 'Nannis Knusper-Rösti', menge: 1, extras: [] }] });
    assert.equal(ohne.ok, true);
    assert.equal(ohne.summe_cent, 1390);
  } finally {
    await s.db.query(vorher);
  }
});
