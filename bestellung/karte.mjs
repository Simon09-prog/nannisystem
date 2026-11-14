// Liest menu.json und macht daraus die Preislisten für die Datenbank (Tabellen artikel und extras).
// Aufruf "npm run karte" schreibt bestellung/karte.sql; den Inhalt nach jeder Preisänderung
// im Supabase-SQL-Editor ausführen. Der lokale Testserver lädt die Karte bei jedem Start selbst.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HIER = fileURLToPath(new URL('.', import.meta.url));
// Diese Kategorien sind Getränke. Die Theke kann sie getrennt vom Essen servieren.
const GETRAENKE = new Set(['kaffee', 'tee-matcha', 'favourites', 'limo', 'fresh', 'soft']);
const cent = p => Math.round(parseFloat(p.replace(',', '.')) * 100);

export function karte() {
  const menu = JSON.parse(readFileSync(HIER + '../menu.json', 'utf8'));
  const artikel = [], extras = [];
  for (const k of menu.kategorien) {
    const gruppen = k.groups ? k.groups.map(g => g.items) : [k.items];
    for (const it of gruppen.flat()) artikel.push({ name: it.name, kategorie: k.id, preis_cent: cent(it.price), getraenk: GETRAENKE.has(k.id) });
    const bloecke = (k.extras || []).flatMap(b => b.items).concat(k.addons ? menu.addons || [] : []);
    for (const [name, preis] of bloecke) {
      // Steht ein Extra doppelt in einer Kategorie (Omelett-Extras und Add-ons), muss der Preis gleich sein
      const schon = extras.find(x => x.kategorie === k.id && x.name === name);
      if (schon && schon.preis_cent !== cent(preis)) throw new Error(`Extra "${name}" hat in "${k.name}" zwei verschiedene Preise`);
      if (!schon) extras.push({ kategorie: k.id, name, preis_cent: cent(preis) });
    }
  }
  return { artikel, extras };
}

export function karteSql() {
  const { artikel, extras } = karte();
  const q = s => "'" + s.replace(/'/g, "''") + "'";
  return [
    '-- Erzeugt aus menu.json mit "npm run karte". Nicht von Hand ändern.',
    'begin;',
    'delete from extras;',
    `delete from artikel where name not in (${artikel.map(a => q(a.name)).join(', ')});`,
    'insert into artikel (name, kategorie, preis_cent, getraenk) values',
    artikel.map(a => `  (${q(a.name)}, ${q(a.kategorie)}, ${a.preis_cent}, ${a.getraenk})`).join(',\n'),
    '  on conflict (name) do update set kategorie = excluded.kategorie, preis_cent = excluded.preis_cent, getraenk = excluded.getraenk;',
    ...(extras.length ? ['insert into extras (kategorie, name, preis_cent) values',
      extras.map(x => `  (${q(x.kategorie)}, ${q(x.name)}, ${x.preis_cent})`).join(',\n') + ';'] : []),
    'commit;', ''
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(HIER + 'karte.sql', karteSql());
  // Alles in einer Datei für die erste Einrichtung bei Supabase: einmal in den SQL-Editor kopieren und ausführen.
  // Die letzte Zeile erzeugt den Theken-Schlüssel und zeigt ihn als Ergebnis an.
  writeFileSync(HIER + 'supabase-einrichten.sql', [readFileSync(HIER + 'schema.sql', 'utf8'), karteSql(),
    '-- Theken-Schlüssel erzeugen. Das Ergebnis unten kopieren und sicher aufbewahren, es wird nur dieses eine Mal angezeigt.',
    'select theke_schluessel_neu() as theken_schluessel;', ''].join('\n'));
  const k = karte();
  console.log(`karte.sql geschrieben: ${k.artikel.length} Artikel, ${k.extras.length} Extras`);
}
