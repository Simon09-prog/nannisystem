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

create or replace function _theke_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select theke_hash = sha256(convert_to(p_key, 'UTF8')) from einstellungen), false)
$$;

-- Speicher sparen: Bezahlte und abgelehnte Bestellungen verschwinden nach 3 Tagen, alles andere nach 30 Tagen.
create or replace function _aufraeumen() returns void
language sql security definer set search_path = public as $$
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
    v_zeilen := v_zeilen || jsonb_build_object('name', a.name, 'menge', v_menge, 'preis_cent', a.preis_cent, 'notiz', v_notiz, 'extras', v_extras, 'getraenk', a.getraenk);
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

-- Bestellung zurückziehen, um sie zu ändern. Geht nur, solange die Theke sie noch nicht angenommen hat.
create or replace function bestellung_zurueckziehen(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
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
  if not v_rest_da then update tische set zahlen_at = null where id = p_tisch; end if;
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
  end loop;
  perform _aufraeumen();
  return jsonb_build_object('ok', true);
end $$;

create or replace function theke_ruf_erledigt(p_key text, p_tisch bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update tische set ruf_at = null where id = p_tisch;
  return jsonb_build_object('ok', true);
end $$;

-- Ausverkauft: Liste aller Artikel und Schalter je Artikel. Gilt immer nur für den heutigen Tag.
create or replace function theke_artikel(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'artikel', coalesce(
    (select jsonb_agg(jsonb_build_object('name', name, 'kategorie', kategorie, 'aus', ausverkauft_am is not distinct from _heute()) order by kategorie, name) from artikel),
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
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'offen', _offen(), 'bewertung_url', (select bewertung_url from einstellungen),
    'zeiten', coalesce((select jsonb_agg(jsonb_build_object('tag', tag, 'von', to_char(von, 'HH24:MI'), 'bis', to_char(bis, 'HH24:MI')) order by tag) from oeffnungszeiten), '[]'::jsonb),
    'ruhetage', coalesce((select jsonb_agg(datum order by datum) from ruhetage where datum >= _heute()), '[]'::jsonb));
end $$;

-- p_zeiten = [{"tag": 1, "von": "10:00", "bis": "18:00"}, ...]; ein Wochentag, der fehlt, ist geschlossen
create or replace function theke_zeiten_setzen(p_key text, p_zeiten jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
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
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if p_an then insert into ruhetage (datum) values (p_datum) on conflict do nothing;
  else delete from ruhetage where datum = p_datum; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Link zur Bewertungsseite (z. B. Google). Leer = kein Link. Nur https-Adressen.
create or replace function theke_bewertung(p_key text, p_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_url text := btrim(coalesce(p_url, ''));
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  if v_url <> '' and (v_url !~ '^https://[^\s"<>]+$' or length(v_url) > 300) then return jsonb_build_object('ok', false, 'fehler', 'ungueltig'); end if;
  update einstellungen set bewertung_url = v_url;
  return jsonb_build_object('ok', true);
end $$;

-- Tagesübersicht: Bestellungen, Umsatz und meistbestellte Artikel von heute (ohne abgelehnte)
create or replace function theke_tag(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_start timestamptz := _heute()::timestamp at time zone 'Europe/Berlin';
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
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
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'laden_code', (select laden_code from einstellungen), 'tische', coalesce(
    (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bereich', bereich, 'code', code) order by bereich, length(name), name) from tische),
    '[]'::jsonb));
end $$;

create or replace function theke_tisch_anlegen(p_key text, p_name text, p_bereich text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text := left(btrim(coalesce(p_name, '')), 20); v_bereich text := left(btrim(coalesce(p_bereich, '')), 30); v_id bigint;
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
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
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  delete from tische where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function theke_tisch_neuer_code(p_key text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  update tische set code = _code(10) where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

create or replace function theke_laden_code_neu(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
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
      theke_ruhetag(text, date, boolean), theke_bewertung(text, text), theke_tag(text),
      theke_tische(text), theke_tisch_anlegen(text, text, text), theke_tisch_loeschen(text, bigint),
      theke_tisch_neuer_code(text, bigint), theke_laden_code_neu(text)
    to anon;
  end if;
end $$;
