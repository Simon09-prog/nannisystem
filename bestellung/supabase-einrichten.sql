-- NANNI Bestellsystem: Datenbank (PostgreSQL / Supabase)
--
-- Grundidee: Der Browser darf KEINE Tabelle direkt lesen oder schreiben.
-- Er darf nur die Funktionen ganz unten aufrufen. Jede Funktion prüft selbst,
-- ob der Aufrufer das darf (Tisch-Code beim Gast, Theken-Schlüssel beim Personal).
--
-- Die Datei kann beliebig oft ausgeführt werden; vorhandene Daten bleiben erhalten.

-- ---------------------------------------------------------------- Tabellen

-- Genau eine Zeile mit den Einstellungen des Ladens
create table if not exists einstellungen (
  id          int primary key default 1 check (id = 1),
  aktiv       boolean not null default true,   -- Bestellen am Handy an/aus
  laden_code  text not null,                   -- Code im gemeinsamen QR-Link (Gast wählt den Tisch selbst)
  theke_hash  bytea                            -- Fingerabdruck des Theken-Schlüssels, nie der Schlüssel selbst
);

create table if not exists tische (
  id       bigint generated always as identity primary key,
  name     text not null,
  bereich  text not null default '',
  code     text not null unique,               -- Code im Link dieses einen Tisches (NFC)
  unique (name, bereich)
);

-- Die Karte mit den echten Preisen. Kommt aus menu.json (siehe karte.sql).
create table if not exists artikel (
  name        text primary key,
  kategorie   text not null,
  preis_cent  int  not null check (preis_cent >= 0)
);

-- Extras gelten je Kategorie (z. B. "Extra Espresso Shot" nur bei Kaffee)
create table if not exists extras (
  kategorie   text not null,
  name        text not null,
  preis_cent  int  not null check (preis_cent >= 0),
  primary key (kategorie, name)
);

create table if not exists bestellungen (
  id          uuid primary key default gen_random_uuid(),
  nr          int  not null,                   -- laufende Nummer des Tages
  tisch_id    bigint references tische on delete set null,
  tisch       text not null,                   -- Name und Bereich als Kopie, damit alte Bestellungen
  bereich     text not null,                   -- lesbar bleiben, wenn ein Tisch gelöscht wird
  status      text not null default 'neu' check (status in ('neu', 'angenommen', 'serviert', 'abgelehnt')),
  summe_cent  int  not null,
  positionen  jsonb not null,                  -- [{name, menge, preis_cent, notiz, extras: [{name, preis_cent}]}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists bestellungen_zeit on bestellungen (created_at);

-- Spätere Erweiterung "Bezahlen" (bei einer schon bestehenden Datenbank werden die Spalten ergänzt)
alter table bestellungen add column if not exists bezahlt_at timestamptz;   -- gesetzt, sobald der Tisch abgerechnet ist
alter table tische       add column if not exists zahlen_at  timestamptz;   -- Gast hat "Wir möchten zahlen" getippt

-- Spätere Erweiterung "Öffnungszeiten": bestellt werden kann nur, wenn das Café geöffnet hat.
alter table einstellungen add column if not exists immer_offen boolean not null default false;   -- true = Zeiten nicht prüfen (zum Testen)
create table if not exists oeffnungszeiten (
  tag  int primary key check (tag between 1 and 7),   -- 1 = Montag ... 7 = Sonntag
  von  time not null,
  bis  time not null
);
insert into oeffnungszeiten (tag, von, bis)
  select * from (values (1, time '10:00', time '18:00'), (2, '10:00', '18:00'), (3, '10:00', '18:00'), (4, '10:00', '18:00'),
                        (5, '10:00', '18:00'), (6, '09:00', '18:00'), (7, '09:00', '17:00')) v
  where not exists (select 1 from oeffnungszeiten);
alter table oeffnungszeiten enable row level security;

-- Spätere Erweiterung "Service": Kellner rufen, ausverkauft, Ruhetage, Bewertungslink
alter table tische        add column if not exists ruf_at timestamptz;            -- Gast hat "Kellner rufen" getippt
alter table artikel       add column if not exists ausverkauft_am date;           -- gilt nur an diesem Tag, am nächsten Tag ist der Artikel wieder da
alter table einstellungen add column if not exists bewertung_url text not null default '';
create table if not exists ruhetage (datum date primary key);                     -- einzelne geschlossene Tage (Feiertag, Betriebsferien)
alter table ruhetage enable row level security;

-- Spätere Erweiterung "Getränke zuerst": Die Karte weiß, was ein Getränk ist, damit die Theke Getränke vor dem Essen servieren kann.
alter table artikel add column if not exists getraenk boolean not null default false;

-- Spätere Erweiterung "Tische öffnen": Ein Tisch ist zunächst geschlossen. Die Theke öffnet ihn, indem sie
-- seine erste Bestellung annimmt; nach dem Bezahlen schließt er sich wieder.
-- (Die Spalte gesperrt_bis stammt von einer früheren Zeitsperre und wird nicht mehr gesetzt.)
alter table tische add column if not exists offen_seit   timestamptz;
alter table tische add column if not exists gesperrt_bis timestamptz;
update tische set gesperrt_bis = null where gesperrt_bis is not null;

-- Spätere Erweiterung "Zugänge und Bremse":
-- Zweiter Schlüssel für die Chefin (Einstellungen, Umsatz, Tische). Solange keiner gesetzt ist, gilt dafür der Theken-Schlüssel.
alter table einstellungen add column if not exists chef_hash bytea;
alter table tische add column if not exists ruf_erledigt_at timestamptz;
-- Zähler für die Bremse: wie oft ein Anschluss etwas in einem Zeitfenster getan hat. Gespeichert wird
-- nur ein Fingerabdruck der IP-Adresse, nicht die Adresse selbst; nach einem Tag wird gelöscht.
create table if not exists zugriffe (
  wer      text not null,
  was      text not null,
  fenster  timestamptz not null,
  anzahl   int not null default 1,
  primary key (wer, was, fenster)
);
alter table zugriffe enable row level security;

-- Spätere Erweiterung "Karte pflegen": Die Chefin kann Preise, Namen und Beschreibungen ändern, Artikel ausblenden
-- und neue anlegen. Ab jetzt ist die Datenbank die gültige Karte; die Website zeigt ihren Stand an.
alter table artikel add column if not exists titel           text not null default '';   -- anderer Anzeigename (leer = name)
alter table artikel add column if not exists beschreibung    text not null default '';
alter table artikel add column if not exists name_en         text not null default '';   -- englischer Name (leer = automatische Übersetzung)
alter table artikel add column if not exists beschreibung_en text not null default '';
alter table artikel add column if not exists versteckt       boolean not null default false;   -- dauerhaft ausgeblendet
alter table artikel add column if not exists eigen           boolean not null default false;   -- im Chef-Bereich angelegt, steht nicht fest in der Website
alter table artikel add column if not exists reihenfolge     int not null default 0;

-- Zeilenschutz an und keine einzige Regel: Direkter Zugriff auf die Tabellen ist damit für alle gesperrt.
alter table einstellungen enable row level security;
alter table tische        enable row level security;
alter table artikel       enable row level security;
alter table extras        enable row level security;
alter table bestellungen  enable row level security;

-- ---------------------------------------------------------------- Helfer (nicht von außen aufrufbar)

create or replace function _code(laenge int) returns text
language sql volatile as $$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, laenge)
$$;

insert into einstellungen (id, laden_code) values (1, _code(10)) on conflict (id) do nothing;

-- Das heutige Datum in deutscher Zeit, egal wo der Server steht
create or replace function _heute() returns date
language sql stable as $$ select (now() at time zone 'Europe/Berlin')::date $$;

-- Hat das Café jetzt geöffnet? Ruhetage gehen vor, sonst gelten die Zeiten des Wochentags.
create or replace function _offen() returns boolean
language sql stable security definer set search_path = public as $$
  select (select immer_offen from einstellungen) or (
    not exists (select 1 from ruhetage where datum = _heute())
    and exists (
      select 1 from oeffnungszeiten
      where tag = extract(isodow from now() at time zone 'Europe/Berlin')
        and (now() at time zone 'Europe/Berlin')::time between von and bis))
$$;

-- Namen der Artikel, die heute ausverkauft sind
create or replace function _ausverkauft() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(name), '[]'::jsonb) from artikel where ausverkauft_am = _heute()
$$;

-- Welcher Tisch gehört zu diesem Link? (Tisch-Code: der Tisch selbst, Laden-Code: der gewählte Tisch)
create or replace function _tisch(p_code text, p_tisch bigint) returns tische
language sql stable security definer set search_path = public as $$
  select t.* from tische t, einstellungen e
  where case when p_code = e.laden_code then t.id = p_tisch else t.code = p_code end
  limit 1
$$;

-- Theken-Zugang: Theken-Schlüssel oder Chef-Schlüssel
create or replace function _theke_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select sha256(convert_to(p_key, 'UTF8')) in (theke_hash, chef_hash) from einstellungen), false)
$$;

-- Chef-Zugang: nur der Chef-Schlüssel. Solange noch keiner gesetzt ist, reicht der Theken-Schlüssel.
create or replace function _chef_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case when chef_hash is null then theke_hash = sha256(convert_to(p_key, 'UTF8'))
                               else chef_hash = sha256(convert_to(p_key, 'UTF8')) end from einstellungen), false)
$$;

-- Bremse bei übermäßiger Nutzung: zählt je Anschluss und Zeitfenster mit und sagt, ob noch erlaubt ist.
-- p_max Aufrufe in p_minuten Minuten. Die Grenzen sind großzügig, weil im Café viele Gäste dasselbe WLAN nutzen.
create or replace function _bremse(p_was text, p_max int, p_minuten int) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_kopf json := nullif(current_setting('request.headers', true), '')::json;
  v_wer text := md5(coalesce(v_kopf->>'cf-connecting-ip', nullif(btrim(split_part(v_kopf->>'x-forwarded-for', ',', 1)), ''), 'unbekannt'));
  v_fenster timestamptz := to_timestamp(floor(extract(epoch from now()) / (p_minuten * 60)) * p_minuten * 60);
  v_anzahl int;
begin
  insert into zugriffe (wer, was, fenster) values (v_wer, p_was, v_fenster)
    on conflict (wer, was, fenster) do update set anzahl = zugriffe.anzahl + 1
    returning anzahl into v_anzahl;
  return v_anzahl <= p_max;
end $$;

-- Speicher sparen: Bezahlte und abgelehnte Bestellungen verschwinden nach 3 Tagen, alles andere nach 30 Tagen.
create or replace function _aufraeumen() returns void
language sql security definer set search_path = public as $$
  update tische set offen_seit = null where offen_seit < now() - interval '12 hours';   -- vergessene Tische schließen
  delete from zugriffe where fenster < now() - interval '1 day';
  delete from bestellungen
  where (created_at < now() - interval '3 days' and (bezahlt_at is not null or status = 'abgelehnt'))
     or created_at < now() - interval '30 days'
$$;

-- Einmal bei der Einrichtung im SQL-Editor ausführen:  select theke_schluessel_neu();
-- Gibt den neuen Theken-Schlüssel zurück. Der alte gilt danach nicht mehr.
create or replace function theke_schluessel_neu() returns text
language plpgsql security definer set search_path = public as $$
declare v_key text := _code(40);
begin
  update einstellungen set theke_hash = sha256(convert_to(v_key, 'UTF8'));
  return v_key;
end $$;

-- ---------------------------------------------------------------- Für Gäste

-- Was darf dieser Link? Tisch-Code: der Tisch steht fest. Laden-Code: Gast wählt den Tisch.
create or replace function tisch_info(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e einstellungen; t tische;
begin
  select * into e from einstellungen;
  if p_code = e.laden_code then
    return jsonb_build_object('ok', true, 'wahl', true, 'aktiv', e.aktiv, 'offen', _offen(), 'ausverkauft', _ausverkauft(), 'bewertung_url', e.bewertung_url, 'tische', coalesce(
      (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bereich', bereich) order by bereich, length(name), name) from tische),
      '[]'::jsonb));
  end if;
  select * into t from tische where code = p_code;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'wahl', false, 'aktiv', e.aktiv, 'offen', _offen(), 'ausverkauft', _ausverkauft(), 'bewertung_url', e.bewertung_url, 'tisch', t.name, 'bereich', t.bereich);
end $$;

-- Bestellung abschicken. Preise, die der Browser mitschickt, werden ignoriert:
-- gerechnet wird nur mit den Preisen aus den Tabellen artikel und extras.
create or replace function bestellung_aufgeben(p_code text, p_positionen jsonb, p_tisch bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e einstellungen; t tische; a artikel;
  pos jsonb; v_menge int; v_notiz text; v_extras jsonb; v_extra_cent int; v_gewollt int;
  v_zeilen jsonb := '[]'::jsonb; v_summe int := 0; v_nr int; v_id uuid;
begin
  select * into e from einstellungen;
  if p_code = e.laden_code then
    select * into t from tische where id = p_tisch;
  else
    select * into t from tische where code = p_code;
  end if;
  if t.id is null then return jsonb_build_object('ok', false, 'fehler', 'tisch'); end if;
  if not e.aktiv then return jsonb_build_object('ok', false, 'fehler', 'pausiert'); end if;
  if not _offen() then return jsonb_build_object('ok', false, 'fehler', 'geschlossen'); end if;
  if t.gesperrt_bis > now() then return jsonb_build_object('ok', false, 'fehler', 'gesperrt'); end if;
  -- Bremse: je Anschluss höchstens 40 Bestellungen in 10 Minuten, im ganzen Laden höchstens 150
  if not _bremse('bestellen', 40, 10)
     or (select count(*) from bestellungen where created_at > now() - interval '10 minutes') >= 150 then
    return jsonb_build_object('ok', false, 'fehler', 'bremse');
  end if;

  -- Bremse gegen Unfug: höchstens 3 noch nicht angenommene Bestellungen je Tisch
  if (select count(*) from bestellungen where tisch_id = t.id and status = 'neu') >= 3 then
    return jsonb_build_object('ok', false, 'fehler', 'zuviele');
  end if;

  if jsonb_typeof(p_positionen) is distinct from 'array' or jsonb_array_length(p_positionen) not between 1 and 30 then
    return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
  end if;

  for pos in select * from jsonb_array_elements(p_positionen) loop
    v_menge := (pos->>'menge')::int;
    v_notiz := left(btrim(coalesce(pos->>'notiz', '')), 200);
    if v_menge is null or v_menge not between 1 and 20 then
      return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
    end if;
    select * into a from artikel where name = pos->>'name';
    if not found then return jsonb_build_object('ok', false, 'fehler', 'artikel'); end if;
    if a.versteckt then return jsonb_build_object('ok', false, 'fehler', 'artikel'); end if;
    if a.ausverkauft_am = _heute() then return jsonb_build_object('ok', false, 'fehler', 'ausverkauft', 'artikel', a.name); end if;

    -- Extras: nur solche, die es in der Kategorie dieses Artikels wirklich gibt
    select count(distinct j->>'name') into v_gewollt
      from jsonb_array_elements(case when jsonb_typeof(pos->'extras') = 'array' then pos->'extras' else '[]'::jsonb end) j;
    select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'preis_cent', x.preis_cent) order by x.name), '[]'::jsonb),
           coalesce(sum(x.preis_cent), 0)
      into v_extras, v_extra_cent
      from extras x
      where x.kategorie = a.kategorie
        and x.name in (select j->>'name' from jsonb_array_elements(case when jsonb_typeof(pos->'extras') = 'array' then pos->'extras' else '[]'::jsonb end) j);
    if jsonb_array_length(v_extras) <> v_gewollt then return jsonb_build_object('ok', false, 'fehler', 'artikel'); end if;

    v_summe := v_summe + (a.preis_cent + v_extra_cent) * v_menge;
    v_zeilen := v_zeilen || jsonb_build_object('name', coalesce(nullif(a.titel, ''), a.name), 'menge', v_menge, 'preis_cent', a.preis_cent, 'notiz', v_notiz, 'extras', v_extras, 'getraenk', a.getraenk);
  end loop;

  -- Laufende Nummer des Tages; die Sperre verhindert doppelte Nummern bei gleichzeitigen Bestellungen
  perform pg_advisory_xact_lock(7726641);
  select coalesce(max(nr), 0) + 1 into v_nr from bestellungen
    where created_at >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';

  insert into bestellungen (nr, tisch_id, tisch, bereich, summe_cent, positionen)
    values (v_nr, t.id, t.name, t.bereich, v_summe, v_zeilen)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'nr', v_nr, 'summe_cent', v_summe);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
end $$;

-- Stand der eigenen Bestellungen. Die IDs sind zufällig und nicht erratbar; nur wer bestellt hat, kennt sie.
create or replace function bestellung_status(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'bezahlt', bezahlt_at is not null)), '[]'::jsonb)
  from bestellungen where id = any (p_ids[1:20])
$$;

-- Der aktuelle Stand der Karte für die Website: alle sichtbaren Artikel und Extras mit Preisen und Texten.
-- Öffentlich lesbar, so wie die Karte selbst.
create or replace function karte_stand() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'artikel', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kategorie', kategorie, 'preis_cent', preis_cent, 'titel', titel,
        'beschreibung', beschreibung, 'name_en', name_en, 'beschreibung_en', beschreibung_en, 'eigen', eigen) order by reihenfolge, name)
      from artikel where not versteckt), '[]'::jsonb),
    'extras', coalesce((select jsonb_agg(jsonb_build_object('kategorie', kategorie, 'name', name, 'preis_cent', preis_cent) order by kategorie, name) from extras), '[]'::jsonb))
$$;

-- Bestellung zurückziehen, um sie zu ändern. Geht nur, solange die Theke sie noch nicht angenommen hat.
create or replace function bestellung_zurueckziehen(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _bremse('zurueck', 30, 10) then return jsonb_build_object('ok', false, 'fehler', 'bremse'); end if;
  delete from bestellungen where id = p_id and status = 'neu';
  if found then return jsonb_build_object('ok', true); end if;
  if exists (select 1 from bestellungen where id = p_id) then return jsonb_build_object('ok', false, 'fehler', 'zu_spaet'); end if;
  return jsonb_build_object('ok', false, 'fehler', 'weg');
end $$;

-- "Wir möchten zahlen": merkt am Tisch vor, dass die Gäste zahlen wollen. Die Theke sieht das sofort.
create or replace function zahlen_wuenschen(p_code text, p_tisch bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e einstellungen; t tische;
begin
  select * into e from einstellungen;
  if p_code = e.laden_code then
    select * into t from tische where id = p_tisch;
  else
    select * into t from tische where code = p_code;
  end if;
  if t.id is null then return jsonb_build_object('ok', false, 'fehler', 'tisch'); end if;
  if not exists (select 1 from bestellungen where tisch_id = t.id and bezahlt_at is null and status <> 'abgelehnt') then
    return jsonb_build_object('ok', false, 'fehler', 'nichts');
  end if;
  if not _bremse('zahlen', 15, 10) then return jsonb_build_object('ok', false, 'fehler', 'bremse'); end if;
  update tische set zahlen_at = coalesce(zahlen_at, now()) where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

-- "Kellner rufen": merkt am Tisch vor, dass jemand kommen soll. Geht auch ohne Bestellung.
create or replace function kellner_rufen(p_code text, p_tisch bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t tische;
begin
  select * into t from _tisch(p_code, p_tisch);
  if t.id is null then return jsonb_build_object('ok', false, 'fehler', 'tisch'); end if;
  if not _offen() then return jsonb_build_object('ok', false, 'fehler', 'geschlossen'); end if;
  -- Bremse: je Anschluss höchstens 15 Rufe in 10 Minuten; nach einem erledigten Ruf ist der Tisch eine Minute still
  if not _bremse('rufen', 15, 10) or t.ruf_erledigt_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'fehler', 'bremse');
  end if;
  update tische set ruf_at = coalesce(ruf_at, now()) where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- Für die Theke (alles nur mit Schlüssel)

-- Alles, was die Theke braucht: offene Bestellungen, noch nicht bezahlte (höchstens 18 Stunden alt),
-- alles von heute und die Tische, die zahlen möchten
create or replace function theke_bestellungen(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'jetzt', now(), 'aktiv', (select aktiv from einstellungen),
    'tische_offen', coalesce((select jsonb_agg(id) from tische where offen_seit is not null), '[]'::jsonb),
    'zahlen', coalesce((select jsonb_agg(jsonb_build_object('tisch_id', id, 'tisch', name, 'bereich', bereich, 'seit', zahlen_at)) from tische where zahlen_at is not null), '[]'::jsonb),
    'rufe', coalesce((select jsonb_agg(jsonb_build_object('tisch_id', id, 'tisch', name, 'bereich', bereich, 'seit', ruf_at) order by ruf_at) from tische where ruf_at is not null), '[]'::jsonb),
    'bestellungen', coalesce(
    (select jsonb_agg(jsonb_build_object('id', id, 'nr', nr, 'tisch_id', tisch_id, 'tisch', tisch, 'bereich', bereich, 'status', status,
        'summe_cent', summe_cent, 'positionen', positionen, 'created_at', created_at, 'updated_at', updated_at, 'bezahlt_at', bezahlt_at) order by created_at)
      from bestellungen
      where status in ('neu', 'angenommen')
         or (bezahlt_at is null and status <> 'abgelehnt' and created_at > now() - interval '18 hours')
         or created_at >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'),
    '[]'::jsonb));
end $$;

create or replace function theke_status(p_key text, p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if p_status not in ('neu', 'angenommen', 'serviert', 'abgelehnt') then return jsonb_build_object('ok', false, 'fehler', 'status'); end if;
  -- Geht eine Bestellung zurück auf "neu" oder "in Arbeit", gilt auch nichts mehr als schon serviert
  update bestellungen set status = p_status, updated_at = now(),
      positionen = case when p_status in ('neu', 'angenommen')
        then (select jsonb_agg(p - 'serviert' order by o) from jsonb_array_elements(positionen) with ordinality x(p, o))
        else positionen end
    where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  -- Tische öffnen: Annehmen öffnet den Tisch
  if p_status = 'angenommen' then
    update tische set offen_seit = coalesce(offen_seit, now()), gesperrt_bis = null
      where id = (select tisch_id from bestellungen where id = p_id);
  end if;
  perform _aufraeumen();
  return jsonb_build_object('ok', true);
end $$;

-- Tisch abrechnen. Ohne Auswahl wird alles Offene bezahlt, mit Auswahl nur diese Positionen (getrennt zahlen):
--   p_auswahl = [{"id": Bestell-ID, "pos": Nummer der Position ab 0, "menge": wie viele davon}]
-- Jede Position merkt sich in "bezahlt", wie viele Stück schon abgerechnet sind.
-- Das ist eine Übersicht zum Kassieren. Den Kassenbon erzeugt weiterhin die Kasse des Cafés.
drop function if exists theke_bezahlt(text, bigint);
create or replace function theke_bezahlt(p_key text, p_tisch bigint, p_auswahl jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b bestellungen; p jsonb; v_pos jsonb; i int;
  v_rest int; v_nimm int; v_einzel int; v_summe int := 0; v_offen boolean; v_rest_da boolean;
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if p_auswahl is not null and jsonb_typeof(p_auswahl) <> 'array' then return jsonb_build_object('ok', false, 'fehler', 'ungueltig'); end if;
  for b in select * from bestellungen where tisch_id = p_tisch and bezahlt_at is null and status <> 'abgelehnt' order by created_at for update loop
    v_pos := b.positionen; v_offen := false;
    for i in 0 .. jsonb_array_length(v_pos) - 1 loop
      p := v_pos -> i;
      v_rest := (p->>'menge')::int - coalesce((p->>'bezahlt')::int, 0);
      if p_auswahl is null then
        v_nimm := v_rest;
      else
        select coalesce(sum((x->>'menge')::int), 0) into v_nimm
          from jsonb_array_elements(p_auswahl) x where x->>'id' = b.id::text and (x->>'pos')::int = i;
        v_nimm := greatest(0, least(v_nimm, v_rest));
      end if;
      if v_nimm > 0 then
        v_einzel := (p->>'preis_cent')::int + coalesce((select sum((e->>'preis_cent')::int) from jsonb_array_elements(p->'extras') e), 0);
        v_summe := v_summe + v_einzel * v_nimm;
        v_pos := jsonb_set(v_pos, array[i::text, 'bezahlt'], to_jsonb(coalesce((p->>'bezahlt')::int, 0) + v_nimm));
      end if;
      if v_nimm < v_rest then v_offen := true; end if;
    end loop;
    update bestellungen
      set positionen = v_pos, updated_at = now(),
          bezahlt_at = case when v_offen then null else now() end,
          status = case when not v_offen and status in ('neu', 'angenommen') then 'serviert' else status end
      where id = b.id;
  end loop;
  v_rest_da := exists (select 1 from bestellungen where tisch_id = p_tisch and bezahlt_at is null and status <> 'abgelehnt');
  -- Alles bezahlt: Zahlwunsch erledigt, der Tisch schließt sich wieder
  if not v_rest_da then update tische set zahlen_at = null, offen_seit = null where id = p_tisch; end if;
  perform _aufraeumen();
  return jsonb_build_object('ok', true, 'summe_cent', v_summe, 'rest', v_rest_da, 'bezahlt_at', now());
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
end $$;

-- Servieren, auch in zwei Schritten: erst nur die Getränke, später der Rest.
-- Jede Position merkt sich in "serviert", ob sie schon am Tisch ist. Erst wenn alles serviert ist, gilt die Bestellung als erledigt.
create or replace function theke_serviert(p_key text, p_ids uuid[], p_nur_getraenke boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bestellungen; v_pos jsonb; v_alle boolean; v_nur boolean := coalesce(p_nur_getraenke, false);
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  for b in select * from bestellungen where id = any (p_ids[1:50]) and status in ('neu', 'angenommen') for update loop
    select jsonb_agg(case when not v_nur or coalesce((p->>'getraenk')::boolean, false) then p || '{"serviert": true}'::jsonb else p end order by o),
           bool_and(not v_nur or coalesce((p->>'getraenk')::boolean, false) or coalesce((p->>'serviert')::boolean, false))
      into v_pos, v_alle
      from jsonb_array_elements(b.positionen) with ordinality x(p, o);
    update bestellungen set positionen = v_pos, updated_at = now(),
        status = case when v_alle then 'serviert' else 'angenommen' end
      where id = b.id;
    update tische set offen_seit = coalesce(offen_seit, now()), gesperrt_bis = null where id = b.tisch_id;
  end loop;
  perform _aufraeumen();
  return jsonb_build_object('ok', true);
end $$;

create or replace function theke_ruf_erledigt(p_key text, p_tisch bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update tische set ruf_at = null, ruf_erledigt_at = now() where id = p_tisch;
  return jsonb_build_object('ok', true);
end $$;

-- Ausverkauft: Liste aller Artikel und Schalter je Artikel. Gilt immer nur für den heutigen Tag.
create or replace function theke_artikel(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'artikel', coalesce(
    (select jsonb_agg(jsonb_build_object('name', name, 'titel', titel, 'kategorie', kategorie, 'aus', ausverkauft_am is not distinct from _heute()) order by kategorie, name) from artikel where not versteckt),
    '[]'::jsonb));
end $$;

create or replace function theke_ausverkauft(p_key text, p_name text, p_aus boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update artikel set ausverkauft_am = case when p_aus then _heute() else null end where name = p_name;
  return jsonb_build_object('ok', found);
end $$;

-- Einstellungen: Öffnungszeiten, Ruhetage, Bewertungslink
create or replace function theke_einstellungen(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'offen', _offen(), 'bewertung_url', (select bewertung_url from einstellungen),
    'chef_gesetzt', (select chef_hash is not null from einstellungen),
    'zeiten', coalesce((select jsonb_agg(jsonb_build_object('tag', tag, 'von', to_char(von, 'HH24:MI'), 'bis', to_char(bis, 'HH24:MI')) order by tag) from oeffnungszeiten), '[]'::jsonb),
    'ruhetage', coalesce((select jsonb_agg(datum order by datum) from ruhetage where datum >= _heute()), '[]'::jsonb));
end $$;

-- p_zeiten = [{"tag": 1, "von": "10:00", "bis": "18:00"}, ...]; ein Wochentag, der fehlt, ist geschlossen
create or replace function theke_zeiten_setzen(p_key text, p_zeiten jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if jsonb_typeof(p_zeiten) is distinct from 'array' then return jsonb_build_object('ok', false, 'fehler', 'ungueltig'); end if;
  delete from oeffnungszeiten;
  insert into oeffnungszeiten (tag, von, bis)
    select (z->>'tag')::int, (z->>'von')::time, (z->>'bis')::time from jsonb_array_elements(p_zeiten) z;
  delete from ruhetage where datum < _heute() - 7;
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
end $$;

create or replace function theke_ruhetag(p_key text, p_datum date, p_an boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if p_an then insert into ruhetage (datum) values (p_datum) on conflict do nothing;
  else delete from ruhetage where datum = p_datum; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Link zur Bewertungsseite (z. B. Google). Leer = kein Link. Nur https-Adressen.
create or replace function theke_bewertung(p_key text, p_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_url text := btrim(coalesce(p_url, ''));
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if v_url <> '' and (v_url !~ '^https://[^\s"<>]+$' or length(v_url) > 300) then return jsonb_build_object('ok', false, 'fehler', 'ungueltig'); end if;
  update einstellungen set bewertung_url = v_url;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- Karte pflegen (nur Chef-Zugang)

create or replace function chef_karte(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true,
    'artikel', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kategorie', kategorie, 'preis_cent', preis_cent, 'titel', titel,
        'beschreibung', beschreibung, 'name_en', name_en, 'beschreibung_en', beschreibung_en, 'versteckt', versteckt, 'eigen', eigen,
        'getraenk', getraenk) order by reihenfolge, name) from artikel), '[]'::jsonb),
    'extras', coalesce((select jsonb_agg(jsonb_build_object('kategorie', kategorie, 'name', name, 'preis_cent', preis_cent) order by kategorie, name) from extras), '[]'::jsonb));
end $$;

-- Artikel ändern oder neu anlegen. p_daten: preis_cent (Pflicht), titel, beschreibung, name_en, beschreibung_en, versteckt, getraenk
-- und bei einem neuen Artikel kategorie. Gibt es p_name schon, wird geändert, sonst angelegt.
create or replace function chef_artikel_speichern(p_key text, p_name text, p_daten jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_preis int; v_kat text;
  kurz constant int := 80; lang constant int := 400;
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if v_name = '' or jsonb_typeof(p_daten) is distinct from 'object' then return jsonb_build_object('ok', false, 'fehler', 'name'); end if;
  v_preis := (p_daten->>'preis_cent')::int;
  if v_preis is null or v_preis not between 0 and 100000 then return jsonb_build_object('ok', false, 'fehler', 'preis'); end if;

  if exists (select 1 from artikel where name = v_name) then
    update artikel set
        preis_cent      = v_preis,
        titel           = left(btrim(coalesce(p_daten->>'titel', titel)), kurz),
        beschreibung    = left(btrim(coalesce(p_daten->>'beschreibung', beschreibung)), lang),
        name_en         = left(btrim(coalesce(p_daten->>'name_en', name_en)), kurz),
        beschreibung_en = left(btrim(coalesce(p_daten->>'beschreibung_en', beschreibung_en)), lang),
        versteckt       = coalesce((p_daten->>'versteckt')::boolean, versteckt),
        getraenk        = coalesce((p_daten->>'getraenk')::boolean, getraenk)
      where name = v_name;
    return jsonb_build_object('ok', true, 'neu', false);
  end if;

  v_kat := p_daten->>'kategorie';
  if v_kat is null or not exists (select 1 from artikel where kategorie = v_kat) then return jsonb_build_object('ok', false, 'fehler', 'kategorie'); end if;
  if (select count(*) from artikel) >= 500 then return jsonb_build_object('ok', false, 'fehler', 'voll'); end if;
  insert into artikel (name, kategorie, preis_cent, beschreibung, name_en, beschreibung_en, versteckt, getraenk, eigen, reihenfolge)
    values (v_name, v_kat, v_preis,
      left(btrim(coalesce(p_daten->>'beschreibung', '')), lang), left(btrim(coalesce(p_daten->>'name_en', '')), kurz),
      left(btrim(coalesce(p_daten->>'beschreibung_en', '')), lang), coalesce((p_daten->>'versteckt')::boolean, false),
      coalesce((p_daten->>'getraenk')::boolean, (select bool_or(getraenk) from artikel where kategorie = v_kat), false),
      true, (select coalesce(max(reihenfolge), 0) + 1 from artikel));
  return jsonb_build_object('ok', true, 'neu', true);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
end $$;

-- Löschen geht nur bei selbst angelegten Artikeln. Die festen Artikel der Website werden ausgeblendet.
create or replace function chef_artikel_loeschen(p_key text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  delete from artikel where name = p_name and eigen;
  if found then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'fehler', 'fest');
end $$;

create or replace function chef_extra_speichern(p_key text, p_kategorie text, p_name text, p_preis_cent int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text := left(btrim(coalesce(p_name, '')), 60);
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if v_name = '' then return jsonb_build_object('ok', false, 'fehler', 'name'); end if;
  if p_preis_cent is null or p_preis_cent not between 0 and 100000 then return jsonb_build_object('ok', false, 'fehler', 'preis'); end if;
  if not exists (select 1 from artikel where kategorie = p_kategorie) then return jsonb_build_object('ok', false, 'fehler', 'kategorie'); end if;
  insert into extras (kategorie, name, preis_cent) values (p_kategorie, v_name, p_preis_cent)
    on conflict (kategorie, name) do update set preis_cent = excluded.preis_cent;
  return jsonb_build_object('ok', true);
end $$;

create or replace function chef_extra_loeschen(p_key text, p_kategorie text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  delete from extras where kategorie = p_kategorie and name = p_name;
  return jsonb_build_object('ok', found);
end $$;

-- Schlüssel neu erzeugen (nur Chef-Zugang). p_art = 'theke' oder 'chef'.
-- Der neue Schlüssel wird genau einmal zurückgegeben; gespeichert wird nur sein Fingerabdruck. Der alte gilt sofort nicht mehr.
create or replace function schluessel_neu(p_key text, p_art text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_neu text := _code(40);
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if p_art = 'chef' then update einstellungen set chef_hash = sha256(convert_to(v_neu, 'UTF8'));
  elsif p_art = 'theke' then update einstellungen set theke_hash = sha256(convert_to(v_neu, 'UTF8'));
  else return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
  end if;
  return jsonb_build_object('ok', true, 'schluessel', v_neu);
end $$;

-- Schlüssel selbst festlegen statt erzeugen lassen (nur Chef-Zugang). Mindestens 8 Zeichen.
create or replace function schluessel_setzen(p_key text, p_art text, p_neu text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_neu text := btrim(coalesce(p_neu, ''));
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if length(v_neu) not between 8 and 100 then return jsonb_build_object('ok', false, 'fehler', 'kurz'); end if;
  if p_art = 'chef' then update einstellungen set chef_hash = sha256(convert_to(v_neu, 'UTF8'));
  elsif p_art = 'theke' then update einstellungen set theke_hash = sha256(convert_to(v_neu, 'UTF8'));
  else return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Notfall-Weg, nur im SQL-Editor von Supabase (von der Website aus nicht erreichbar):
--   select chef_passwort_setzen('euer neues passwort');
--   select theke_passwort_setzen('euer neues passwort');
-- Damit kommt man wieder hinein, wenn ein Schlüssel verloren gegangen ist.
create or replace function chef_passwort_setzen(p_neu text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if length(btrim(coalesce(p_neu, ''))) < 8 then return 'Zu kurz: mindestens 8 Zeichen.'; end if;
  update einstellungen set chef_hash = sha256(convert_to(btrim(p_neu), 'UTF8'));
  return 'Chef-Passwort gesetzt.';
end $$;
create or replace function theke_passwort_setzen(p_neu text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if length(btrim(coalesce(p_neu, ''))) < 8 then return 'Zu kurz: mindestens 8 Zeichen.'; end if;
  update einstellungen set theke_hash = sha256(convert_to(btrim(p_neu), 'UTF8'));
  return 'Theken-Passwort gesetzt.';
end $$;

-- Tagesübersicht: Bestellungen, Umsatz und meistbestellte Artikel von heute (ohne abgelehnte)
create or replace function theke_tag(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_start timestamptz := _heute()::timestamp at time zone 'Europe/Berlin';
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'datum', _heute(),
    'anzahl', (select count(*) from bestellungen where created_at >= v_start and status <> 'abgelehnt'),
    'abgelehnt', (select count(*) from bestellungen where created_at >= v_start and status = 'abgelehnt'),
    'umsatz_cent', (select coalesce(sum(summe_cent), 0) from bestellungen where created_at >= v_start and status <> 'abgelehnt'),
    'tische', (select count(distinct tisch_id) from bestellungen where created_at >= v_start and status <> 'abgelehnt'),
    'top', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'menge', menge) order by menge desc, name) from (
        select p->>'name' as name, sum((p->>'menge')::int) as menge
        from bestellungen, jsonb_array_elements(positionen) p
        where created_at >= v_start and status <> 'abgelehnt'
        group by 1 order by 2 desc, 1 limit 10) x), '[]'::jsonb));
end $$;

create or replace function theke_aktiv(p_key text, p_aktiv boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update einstellungen set aktiv = coalesce(p_aktiv, true);
  return jsonb_build_object('ok', true);
end $$;

create or replace function theke_tische(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'laden_code', (select laden_code from einstellungen), 'tische', coalesce(
    (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bereich', bereich, 'code', code) order by bereich, length(name), name) from tische),
    '[]'::jsonb));
end $$;

create or replace function theke_tisch_anlegen(p_key text, p_name text, p_bereich text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text := left(btrim(coalesce(p_name, '')), 20); v_bereich text := left(btrim(coalesce(p_bereich, '')), 30); v_id bigint;
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if v_name = '' then return jsonb_build_object('ok', false, 'fehler', 'name'); end if;
  if (select count(*) from tische) >= 200 then return jsonb_build_object('ok', false, 'fehler', 'voll'); end if;
  insert into tische (name, bereich, code) values (v_name, v_bereich, _code(10))
    on conflict (name, bereich) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('ok', false, 'fehler', 'doppelt'); end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function theke_tisch_loeschen(p_key text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  delete from tische where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function theke_tisch_neuer_code(p_key text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update tische set code = _code(10) where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function theke_laden_code_neu(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _chef_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update einstellungen set laden_code = _code(10);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- Rechte
-- Erst allen alles wegnehmen, dann dem Browser (Rolle "anon" bei Supabase) genau diese Funktionen erlauben.
revoke execute on all functions in schema public from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke execute on all functions in schema public from anon, authenticated;
    grant execute on function
      tisch_info(text), bestellung_aufgeben(text, jsonb, bigint), bestellung_status(uuid[]), bestellung_zurueckziehen(uuid), zahlen_wuenschen(text, bigint), kellner_rufen(text, bigint),
      theke_bestellungen(text), theke_status(text, uuid, text), theke_bezahlt(text, bigint, jsonb), theke_serviert(text, uuid[], boolean), theke_ruf_erledigt(text, bigint), theke_aktiv(text, boolean),
      theke_artikel(text), theke_ausverkauft(text, text, boolean), theke_einstellungen(text), theke_zeiten_setzen(text, jsonb),
      theke_ruhetag(text, date, boolean), theke_bewertung(text, text), theke_tag(text), schluessel_neu(text, text), schluessel_setzen(text, text, text), karte_stand(), chef_karte(text), chef_artikel_speichern(text, text, jsonb),
      chef_artikel_loeschen(text, text), chef_extra_speichern(text, text, text, int), chef_extra_loeschen(text, text, text),
      theke_tische(text), theke_tisch_anlegen(text, text, text), theke_tisch_loeschen(text, bigint),
      theke_tisch_neuer_code(text, bigint), theke_laden_code_neu(text)
    to anon;
  end if;
end $$;

-- Erzeugt aus menu.json mit "npm run karte". Nicht von Hand ändern.
begin;
insert into artikel (name, kategorie, preis_cent, getraenk, beschreibung) values
  ('Café Crema', 'kaffee', 320, true, ''),
  ('Americano', 'kaffee', 350, true, ''),
  ('Espresso', 'kaffee', 290, true, ''),
  ('Espresso Doppio', 'kaffee', 440, true, ''),
  ('Espresso Macchiato', 'kaffee', 330, true, ''),
  ('Cappuccino', 'kaffee', 390, true, ''),
  ('Flat White', 'kaffee', 530, true, ''),
  ('Milchkaffee', 'kaffee', 450, true, ''),
  ('Latte Macchiato', 'kaffee', 450, true, ''),
  ('Kaffee & Kuchen Deal', 'kaffee', 600, true, 'Immer montags von 12 bis 18 Uhr.'),
  ('Earl Grey', 'tee-matcha', 350, true, 'Feiner Schwarztee mit Bergamotte-Aroma.'),
  ('Jasmin-Grüntee', 'tee-matcha', 350, true, 'Frisch aufgegossen – leicht, blumig und wohltuend.'),
  ('Früchtetee Waldbeere', 'tee-matcha', 350, true, 'Aus feinen Beerennoten – fruchtig, süß-säuerlich und aromatisch.'),
  ('Frischer Minztee', 'tee-matcha', 420, true, 'Aus frischer Minze – mild und beruhigend.'),
  ('Frischer Ingwer-Zitronentee', 'tee-matcha', 420, true, 'Frischer Ingwer – wärmend, intensiv und natürlich erfrischend.'),
  ('Hot Matcha', 'tee-matcha', 590, true, ''),
  ('Iced Matcha', 'tee-matcha', 590, true, ''),
  ('Strawberry Iced Matcha', 'tee-matcha', 650, true, ''),
  ('Mango Iced Matcha', 'tee-matcha', 650, true, ''),
  ('Iced Americano', 'favourites', 390, true, ''),
  ('Iced Latte', 'favourites', 450, true, ''),
  ('Iced Vanilla Latte', 'favourites', 520, true, ''),
  ('Iced Chai Latte', 'favourites', 490, true, ''),
  ('Chai Latte', 'favourites', 490, true, ''),
  ('Pumpkin Spice Latte', 'favourites', 550, true, ''),
  ('Hot Chocolate', 'favourites', 450, true, ''),
  ('Hot White Chocolate', 'favourites', 450, true, ''),
  ('Pfirsich-Limo', 'limo', 490, true, 'Pfirsichsirup und Mineralwasser.'),
  ('Zitronen-Minze-Holunder-Limo', 'limo', 650, true, 'Zitrone, Minze, Ingwersirup, Holundersirup und Mineralwasser.'),
  ('Himbeer-Minze-Holunder-Limo', 'limo', 650, true, 'Zitrone, Minze, Himbeersirup, Holundersirup und Mineralwasser.'),
  ('Maracuja-Limette-Limo', 'limo', 650, true, 'Limette, Maracujasirup und Mineralwasser.'),
  ('Frisch gepresster Orangensaft', 'fresh', 590, true, 'Frisch gepresst und ohne Zusätze.'),
  ('Beet & Juice', 'fresh', 650, true, 'Frisch gepresster Mix aus Roter Bete, Apfel, Möhre, Ingwer, Zitrone und frischem Orangensaft – fruchtig und leicht würzig.'),
  ('Berry Banana', 'fresh', 690, true, 'Beerenmix, Banane, Apfel und Orange – fruchtig, cremig und harmonisch.'),
  ('Green Glow', 'fresh', 690, true, 'Spinat, Banane, Apfel, Mango und Zitrone – frisch, fruchtig und belebend.'),
  ('Mango Sunshine', 'fresh', 690, true, 'Mango, Banane, Orange und Passionsfruchtsirup – fruchtig und erfrischend.'),
  ('fritz-kola 0,2 l', 'soft', 330, true, ''),
  ('fritz-kola super zero 0,2 l', 'soft', 330, true, ''),
  ('fritz-limo Apfel-Kirsch-Holunder 0,2 l', 'soft', 330, true, ''),
  ('fritz-spritz Bio-Rhabarberschorle 0,2 l', 'soft', 330, true, ''),
  ('Zurück zu den Quellen, still 0,33 l', 'soft', 350, true, ''),
  ('Zurück zu den Quellen, sprudelnd 0,33 l', 'soft', 350, true, ''),
  ('Rührei Genuss', 'fruehstueck', 790, false, 'Cremiges Rührei, geröstetes Sauerteigbrot und Frischkäsecreme.'),
  ('Omelett-Bar', 'fruehstueck', 890, false, 'Frisch zubereitetes Omelett mit Brot und Frischkäsecreme – verfeinere dein Omelett mit den Extras unten.'),
  ('Nannis Brunch-Favourite', 'fruehstueck', 1490, false, 'Cremiges Rührei auf geröstetem Sauerteigbrot mit Avocado, Tomaten, Pickled Onions und Granatapfelkernen. Dazu zwei fluffige vegane Pancakes mit Beeren, Soja-Vanillecreme und Bio-Ahornsirup.'),
  ('Classic Açaí Bowl', 'bowls', 1190, false, 'Cremige Açaí, kalt serviert mit Beeren, Banane, Crunchy Granola, Chiasamen und Kokosflocken – verfeinert mit Dattelsirup.'),
  ('Lotus Crunch Açaí Bowl', 'bowls', 1290, false, 'Cremige Açaí, kalt serviert mit Beeren, Banane, Crunchy Granola, Soja-Vanillecreme, Chiasamen und Kokosflocken – getoppt mit Lotus Swirl und Lotus Crumble.'),
  ('Apfel Crunch Porridge', 'bowls', 990, false, 'Warmes, cremiges Porridge mit Apfelkompott und Apfelstücken, Granola, gemahlenen Haselnüssen, Kokosflocken und Zimt – verfeinert mit einem Hauch Lotus Swirl.'),
  ('Nanni Egg Drop', 'shokupan', 1090, false, 'Goldbraun getoastet mit Topping deiner Wahl, Cheddar-Melt, fluffigem, cremigem Rührei und Avocado, dazu hausgemachter Sweet-Cream-Senf als Finish. Topping: Bacon, Sucuk, Lachs oder Tofu. Sauce: Trüffelcreme oder Sriracha-Mayo.'),
  ('Halloumi-Honey Drop', 'shokupan', 1290, false, 'Toskanacreme, Rucola, Halloumi, Tomaten, Honig, Kürbiskerne, Chili und Granatapfel-Drizzle.'),
  ('Pastrami New York Style Drop', 'shokupan', 1390, false, 'Frischkäse, Rucola, Tomaten, Pastrami, Cornichons und Käse-Melt, Dattel-Senf-Dressing und Balsamico.'),
  ('Burrata Italia', 'shokupan', 1390, false, 'Pesto, Rucola, Tomaten, Burrata, geröstete Pinienkerne, Olivenöl und Balsamico-Drizzle.'),
  ('Kleine Süßkartoffel-Pommes + Dip', 'shokupan', 390, false, 'Zu deinem Shokupan. Dip: Trüffelcreme, Kräuterquark, vegane Mayo oder Ketchup.'),
  ('Süßkartoffel-Pancakes mit Halloumi', 'pancakes', 1290, false, 'Vegane Creme, Rucola, Tomaten, Halloumi, Chiliflocken, Kürbiskerne und Granatapfel-Drizzle.'),
  ('Süßkartoffel-Pancakes mit Tofu & Avocado', 'pancakes', 1290, false, 'Vegane Creme, Rucola, Tomaten, Tofu, Avocado, Granatapfelkerne und Granatapfel-Drizzle.'),
  ('Süßkartoffel-Pancakes Vegan Greek', 'pancakes', 1290, false, 'Vegane Creme, Rucola, Tomate, Avocado, veganer Hirtenkäse, Granatapfelkerne und Balsamico.'),
  ('Süßkartoffel-Pancakes Apple Lotus', 'pancakes', 1190, false, 'Apfelkompott, Mandelblättchen und Lotus-Swirl.'),
  ('Avocado & Poached Egg', 'bagels', 990, false, 'Frischkäse, Rucola, Tomaten, Avocado, pochiertes Ei und Sweet-Cream-Senf-Drizzle.'),
  ('Smoky Tofu Bagel', 'bagels', 990, false, 'Frischkäse, Rucola, Tomaten, Avocado, Tofu, Pickled Onions und Granatapfel-Drizzle.'),
  ('Sucuk Egg Bagel', 'bagels', 990, false, 'Avocado-Mash, Rucola, Tomate, Rührei, Sucuk und Sriracha-Mayo.'),
  ('Egg Bagel', 'bagels', 890, false, 'Frischkäse, Rucola, Tomate, Rührei, veganes Reibe-Topping und Maple-Mustard-Drizzle.'),
  ('Salmon Bagel', 'bagels', 1090, false, 'Frisch belegt mit Frischkäse, Rucola, Gurkensalat, Lachs, Pickled Onions und Dill-Dattelsenf-Dressing. Auch mit veganem Lachs.'),
  ('Golden Goat Club Sandwich', 'lunch', 1490, false, 'Frischkäse, Rucola, Tomaten, Avocado, karamellisierter Ziegenkäse und Walnüsse. Dazu Süßkartoffel-Pommes mit veganem Reibe-Topping und Dip.'),
  ('Chicken Karaage Burger', 'lunch', 1550, false, 'Brioche Bun, Honey-Mustard-Sauce, Romanasalat, Tomate, Chicken Karaage, Cheddar-Melt und Pickled Onions. Dazu Süßkartoffel-Pommes mit veganem Reibe-Topping und Dip.'),
  ('Avocado-Halloumi Burger', 'lunch', 1550, false, 'Brioche Bun, Avocado-Mash, Romanasalat, Tomate, Avocado, Halloumi, Honig-Drizzle, Pickled Onions und hausgemachte Honig-Senf-Sauce. Dazu Süßkartoffel-Pommes mit veganem Reibe-Topping und Dip.'),
  ('Süßkartoffel-Pommes mit Dip', 'lunch', 690, false, 'Dip deiner Wahl: Trüffelcreme, Kräuterquark, vegane Mayo oder Ketchup.'),
  ('Classic French Toast', 'sweets', 1250, false, 'Goldbraun gebraten, serviert mit hausgemachter Vanille-Mascarpone-Creme, Beerenkompott, frischen Beeren, karamellisierter Banane, Bio-Ahornsirup und Brownie-Crumble.'),
  ('Classy Berry Pancakes', 'sweets', 1190, false, 'Goldbraun gebackene vegane Pancakes mit Beeren, cremiger Soja-Vanillecreme und Bio-Ahornsirup.'),
  ('Bueno Berry Pancakes', 'sweets', 1190, false, 'Goldbraun gebackene vegane Pancakes mit Beeren, Bueno Crumble und Bueno-Sauce.'),
  ('Nannis Vegan Banana Bread', 'sweets', 990, false, 'Getoastetes veganes Bananenbrot aus glutenfreien Zutaten mit Soja-Vanillecreme, Banane, Beeren, hausgemachtem Granola und Bio-Ahornsirup.'),
  ('Classic Vegan', 'waffeln', 390, false, 'Puderzucker.'),
  ('Banana Choc', 'waffeln', 690, false, 'Puderzucker, Bananen, Schokodrops und Schokosauce.'),
  ('Lotus Crunch', 'waffeln', 750, false, 'Puderzucker, Apfelkompott, Lotus-Creme und Lotus-Crumble.'),
  ('White Bueno Crunch', 'waffeln', 790, false, 'Puderzucker, Bueno-Haselnusssauce, weiße Schokosauce, gemahlene Haselnüsse und Bueno-Crunch.'),
  ('Heiße Liebe', 'waffeln', 590, false, 'Puderzucker und heiße Kirschen.'),
  ('Kirschtraum', 'waffeln', 690, false, 'Puderzucker, heiße Kirschen und hausgemachte Mascarpone-Creme.'),
  ('Oreo Berry Banana', 'waffeln', 750, false, 'Puderzucker, Banane, Oreo-Crunch und Erdbeersauce.')
  on conflict (name) do update set beschreibung = case when artikel.beschreibung = '' then excluded.beschreibung else artikel.beschreibung end;
insert into extras (kategorie, name, preis_cent) values
  ('kaffee', 'Extra Espresso Shot', 150),
  ('kaffee', 'Sahne', 80),
  ('kaffee', 'Flavours', 100),
  ('fruehstueck', 'Tomaten', 80),
  ('fruehstueck', 'Rote Zwiebeln', 80),
  ('fruehstueck', 'Paprika', 80),
  ('fruehstueck', 'Rucola', 80),
  ('fruehstueck', 'Käse', 150),
  ('fruehstueck', 'Avocado', 200),
  ('fruehstueck', 'Sucuk', 200),
  ('fruehstueck', 'Bacon', 250),
  ('fruehstueck', 'Halloumi', 250),
  ('fruehstueck', 'Lachs', 250),
  ('fruehstueck', 'Pochiertes Ei', 150),
  ('fruehstueck', 'Veganer Lachs', 280),
  ('fruehstueck', 'Pastrami', 280),
  ('fruehstueck', 'Burrata', 450),
  ('shokupan', 'Pochiertes Ei', 150),
  ('shokupan', 'Avocado', 200),
  ('shokupan', 'Sucuk', 200),
  ('shokupan', 'Halloumi', 250),
  ('shokupan', 'Lachs', 250),
  ('shokupan', 'Veganer Lachs', 280),
  ('shokupan', 'Pastrami', 280),
  ('shokupan', 'Bacon', 250),
  ('shokupan', 'Burrata', 450),
  ('pancakes', 'Pochiertes Ei', 150),
  ('pancakes', 'Avocado', 200),
  ('pancakes', 'Sucuk', 200),
  ('pancakes', 'Halloumi', 250),
  ('pancakes', 'Lachs', 250),
  ('pancakes', 'Veganer Lachs', 280),
  ('pancakes', 'Pastrami', 280),
  ('pancakes', 'Bacon', 250),
  ('pancakes', 'Burrata', 450),
  ('bagels', 'Pochiertes Ei', 150),
  ('bagels', 'Avocado', 200),
  ('bagels', 'Sucuk', 200),
  ('bagels', 'Halloumi', 250),
  ('bagels', 'Lachs', 250),
  ('bagels', 'Veganer Lachs', 280),
  ('bagels', 'Pastrami', 280),
  ('bagels', 'Bacon', 250),
  ('bagels', 'Burrata', 450),
  ('lunch', 'Pochiertes Ei', 150),
  ('lunch', 'Avocado', 200),
  ('lunch', 'Sucuk', 200),
  ('lunch', 'Halloumi', 250),
  ('lunch', 'Lachs', 250),
  ('lunch', 'Veganer Lachs', 280),
  ('lunch', 'Pastrami', 280),
  ('lunch', 'Bacon', 250),
  ('lunch', 'Burrata', 450),
  ('waffeln', 'Veganes Vanilleeis', 120),
  ('waffeln', 'Sahne', 80),
  ('waffeln', 'Ahornsirup', 100)
  on conflict (kategorie, name) do nothing;
commit;

-- Theken-Schlüssel erzeugen. Das Ergebnis unten kopieren und sicher aufbewahren, es wird nur dieses eine Mal angezeigt.
select theke_schluessel_neu() as theken_schluessel;
