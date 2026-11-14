// Lokaler Testserver: Website + Bestell-Datenbank auf dem eigenen Rechner, ohne Konto und ohne Internet.
// Er lädt dieselbe schema.sql wie später Supabase in eine eingebaute PostgreSQL (PGlite)
// und beantwortet /rest/v1/rpc/<funktion> genauso wie Supabase.
// Start: npm start   ->  http://localhost:8787
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { karteSql } from './karte.mjs';

const HIER = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HIER, '..');
const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
// Nur diese Funktionen sind von außen erreichbar (wie die "grant"-Liste am Ende von schema.sql)
const ERLAUBT = new Set(['tisch_info', 'bestellung_aufgeben', 'bestellung_status', 'zahlen_wuenschen', 'theke_bezahlt', 'kellner_rufen', 'theke_ruf_erledigt', 'bestellung_zurueckziehen', 'theke_serviert', 'theke_artikel', 'theke_ausverkauft',
  'theke_einstellungen', 'theke_zeiten_setzen', 'theke_ruhetag', 'theke_bewertung', 'theke_tag', 'theke_bestellungen', 'theke_status', 'theke_aktiv',
  'theke_tische', 'theke_tisch_anlegen', 'theke_tisch_loeschen', 'theke_tisch_neuer_code', 'theke_laden_code_neu']);

// memory: true = frische Datenbank nur im Arbeitsspeicher (für Tests)
export async function start({ port = 8787, memory = false } = {}) {
  const ordner = join(HIER, 'daten.local');
  if (!memory) await mkdir(ordner, { recursive: true });
  const db = new PGlite(memory ? undefined : join(ordner, 'db'));
  await db.exec(readFileSync(join(HIER, 'schema.sql'), 'utf8'));
  await db.exec(karteSql());
  // Auf dem eigenen Rechner soll man zu jeder Uhrzeit testen können
  if (!memory) await db.exec('update einstellungen set immer_offen = true');

  // Zum Ausprobieren ein paar Tische anlegen, solange es noch keine gibt
  if (!memory) await db.exec(`insert into tische (name, bereich, code)
    select n::text, b, _code(10) from (values ('Drinnen', 6), ('Draußen', 4)) v(b, anz), generate_series(1, anz) n
    where not exists (select 1 from tische)`);

  // Theken-Schlüssel: beim ersten Start erzeugen und lokal merken
  const keyDatei = join(ordner, 'theke-key.txt');
  let thekeKey = !memory && existsSync(keyDatei) ? readFileSync(keyDatei, 'utf8').trim() : null;
  if (!thekeKey) {
    thekeKey = (await db.query('select theke_schluessel_neu() as k')).rows[0].k;
    if (!memory) await writeFile(keyDatei, thekeKey);
  }

  // Namen und Typen der Parameter aus der Datenbank lesen, damit JSON sauber umgewandelt wird
  const sig = {};
  const procs = await db.query(`select p.proname, coalesce(p.proargnames, '{}') as namen,
      array(select format_type(t, null) from unnest(p.proargtypes) t) as typen
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
  for (const p of procs.rows) sig[p.proname] = p.namen.map((name, i) => ({ name, typ: p.typen[i] }));

  async function rpc(fn, args) {
    if (!ERLAUBT.has(fn) || !sig[fn]) return { status: 404, body: { message: 'Funktion nicht gefunden' } };
    const teile = [], werte = [];
    for (const [name, wert] of Object.entries(args)) {
      const p = sig[fn].find(x => x.name === name);
      if (!p) return { status: 404, body: { message: 'Unbekannter Parameter ' + name } };
      werte.push(JSON.stringify(wert ?? null));
      const n = '$' + werte.length + '::jsonb';
      teile.push(`${name} => ` + (p.typ === 'jsonb' ? n
        : p.typ.endsWith('[]') ? `array(select jsonb_array_elements_text(${n}))::${p.typ}`
        : `(${n} #>> '{}')::${p.typ}`));
    }
    try {
      const res = await db.query(`select ${fn}(${teile.join(', ')}) as r`, werte);
      return { status: 200, body: res.rows[0].r };
    } catch (err) {
      return { status: 400, body: { message: err.message } };
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      let roh = '';
      for await (const chunk of req) roh += chunk;
      let args = {};
      try { args = roh ? JSON.parse(roh) : {}; } catch { /* leeres Objekt */ }
      const out = await rpc(m[1], args);
      res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(out.body));
    }
    // Statische Dateien der Website; lokale Daten und node_modules bleiben gesperrt
    let pfad = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
    if (pfad === '' || pfad.endsWith('/') || pfad.endsWith('\\')) pfad += 'index.html';
    const datei = join(ROOT, pfad);
    if (!datei.startsWith(ROOT) || /node_modules|\.local|^\.git/.test(pfad)) { res.writeHead(403); return res.end(); }
    try {
      const inhalt = await readFile(datei);
      res.writeHead(200, { 'content-type': TYPEN[extname(datei)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(inhalt);
    } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Nicht gefunden'); }
  });
  await new Promise(ok => server.listen(port, ok));
  const basis = 'http://localhost:' + server.address().port;
  return { basis, thekeKey, db, rpc: async (fn, args = {}) => (await rpc(fn, args)).body,
    stop: async () => { await new Promise(ok => server.close(ok)); await db.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await start({ port: +process.env.PORT || 8787 });
  const laden = (await s.db.query('select laden_code from einstellungen')).rows[0].laden_code;
  const t1 = (await s.db.query('select name, bereich, code from tische order by id limit 1')).rows[0];
  console.log(`
NANNI Testserver läuft.

  Website:        ${s.basis}/
  Karte (lesen):  ${s.basis}/karte.html
  Bestellen, Gast wählt den Tisch (gemeinsamer QR-Link):
                  ${s.basis}/karte.html?t=${laden}
  Bestellen an Tisch ${t1.name} ${t1.bereich} (eigener Link des Tisches):
                  ${s.basis}/karte.html?t=${t1.code}
  Theke:
                  ${s.basis}/theke.html#k=${s.thekeKey}

Beenden mit Strg+C. Die Testdaten liegen in bestellung/daten.local/.
`);
}
