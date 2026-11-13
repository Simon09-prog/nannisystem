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
    return jsonb_build_object('ok', true, 'wahl', true, 'aktiv', e.aktiv, 'tische', coalesce(
      (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bereich', bereich) order by bereich, length(name), name) from tische),
      '[]'::jsonb));
  end if;
  select * into t from tische where code = p_code;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'wahl', false, 'aktiv', e.aktiv, 'tisch', t.name, 'bereich', t.bereich);
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
    v_zeilen := v_zeilen || jsonb_build_object('name', a.name, 'menge', v_menge, 'preis_cent', a.preis_cent, 'notiz', v_notiz, 'extras', v_extras);
  end loop;

  -- Laufende Nummer des Tages; die Sperre verhindert doppelte Nummern bei gleichzeitigen Bestellungen
  perform pg_advisory_xact_lock(7726641);
  select count(*) + 1 into v_nr from bestellungen
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

-- ---------------------------------------------------------------- Für die Theke (alles nur mit Schlüssel)

-- Alles, was die Theke braucht: offene Bestellungen, noch nicht bezahlte (höchstens 18 Stunden alt),
-- alles von heute und die Tische, die zahlen möchten
create or replace function theke_bestellungen(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  return jsonb_build_object('ok', true, 'jetzt', now(), 'aktiv', (select aktiv from einstellungen),
    'zahlen', coalesce((select jsonb_agg(jsonb_build_object('tisch_id', id, 'seit', zahlen_at)) from tische where zahlen_at is not null), '[]'::jsonb),
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
  update bestellungen set status = p_status, updated_at = now() where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  perform _aufraeumen();
  return jsonb_build_object('ok', true);
end $$;

-- Tisch abrechnen: alle offenen Bestellungen des Tisches gelten als bezahlt, der Zahlwunsch ist erledigt.
-- Das ist eine Übersicht zum Kassieren. Den Kassenbon erzeugt weiterhin die Kasse des Cafés.
create or replace function theke_bezahlt(p_key text, p_tisch bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_summe int; v_anzahl int;
begin
  if not _theke_ok(p_key) then return jsonb_build_object('ok', false, 'fehler', 'key'); end if;
  with fertig as (
    update bestellungen
      set bezahlt_at = now(), updated_at = now(),
          status = case when status in ('neu', 'angenommen') then 'serviert' else status end
      where tisch_id = p_tisch and bezahlt_at is null and status <> 'abgelehnt'
      returning summe_cent)
  select coalesce(sum(summe_cent), 0), count(*) into v_summe, v_anzahl from fertig;
  update tische set zahlen_at = null where id = p_tisch;
  perform _aufraeumen();
  return jsonb_build_object('ok', true, 'summe_cent', v_summe, 'anzahl', v_anzahl, 'bezahlt_at', now());
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
-- Erst allen alles wegnehmen, dann dem Browser (Rolle "anon" bei Supabase) genau die 13 Funktionen erlauben.
revoke execute on all functions in schema public from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke execute on all functions in schema public from anon, authenticated;
    grant execute on function
      tisch_info(text), bestellung_aufgeben(text, jsonb, bigint), bestellung_status(uuid[]), zahlen_wuenschen(text, bigint),
      theke_bestellungen(text), theke_status(text, uuid, text), theke_bezahlt(text, bigint), theke_aktiv(text, boolean),
      theke_tische(text), theke_tisch_anlegen(text, text, text), theke_tisch_loeschen(text, bigint),
      theke_tisch_neuer_code(text, bigint), theke_laden_code_neu(text)
    to anon;
  end if;
end $$;

-- Erzeugt aus menu.json mit "npm run karte". Nicht von Hand ändern.
begin;
delete from extras;
delete from artikel;
insert into artikel (name, kategorie, preis_cent) values
  ('Café Crema', 'kaffee', 320),
  ('Americano', 'kaffee', 350),
  ('Espresso', 'kaffee', 290),
  ('Espresso Doppio', 'kaffee', 440),
  ('Espresso Macchiato', 'kaffee', 330),
  ('Cappuccino', 'kaffee', 390),
  ('Flat White', 'kaffee', 530),
  ('Milchkaffee', 'kaffee', 450),
  ('Latte Macchiato', 'kaffee', 450),
  ('Kaffee & Kuchen Deal', 'kaffee', 600),
  ('Earl Grey', 'tee-matcha', 350),
  ('Jasmin-Grüntee', 'tee-matcha', 350),
  ('Früchtetee Waldbeere', 'tee-matcha', 350),
  ('Frischer Minztee', 'tee-matcha', 420),
  ('Frischer Ingwer-Zitronentee', 'tee-matcha', 420),
  ('Hot Matcha', 'tee-matcha', 590),
  ('Iced Matcha', 'tee-matcha', 590),
  ('Strawberry Iced Matcha', 'tee-matcha', 650),
  ('Mango Iced Matcha', 'tee-matcha', 650),
  ('Iced Americano', 'favourites', 390),
  ('Iced Latte', 'favourites', 450),
  ('Iced Vanilla Latte', 'favourites', 520),
  ('Iced Chai Latte', 'favourites', 490),
  ('Chai Latte', 'favourites', 490),
  ('Pumpkin Spice Latte', 'favourites', 550),
  ('Hot Chocolate', 'favourites', 450),
  ('Hot White Chocolate', 'favourites', 450),
  ('Pfirsich-Limo', 'limo', 490),
  ('Zitronen-Minze-Holunder-Limo', 'limo', 650),
  ('Himbeer-Minze-Holunder-Limo', 'limo', 650),
  ('Maracuja-Limette-Limo', 'limo', 650),
  ('Frisch gepresster Orangensaft', 'fresh', 590),
  ('Beet & Juice', 'fresh', 650),
  ('Berry Banana', 'fresh', 690),
  ('Green Glow', 'fresh', 690),
  ('Mango Sunshine', 'fresh', 690),
  ('fritz-kola 0,2 l', 'soft', 330),
  ('fritz-kola super zero 0,2 l', 'soft', 330),
  ('fritz-limo Apfel-Kirsch-Holunder 0,2 l', 'soft', 330),
  ('fritz-spritz Bio-Rhabarberschorle 0,2 l', 'soft', 330),
  ('Zurück zu den Quellen, still 0,33 l', 'soft', 350),
  ('Zurück zu den Quellen, sprudelnd 0,33 l', 'soft', 350),
  ('Rührei Genuss', 'fruehstueck', 790),
  ('Omelett-Bar', 'fruehstueck', 890),
  ('Nannis Brunch-Favourite', 'fruehstueck', 1490),
  ('Classic Açaí Bowl', 'bowls', 1190),
  ('Lotus Crunch Açaí Bowl', 'bowls', 1290),
  ('Apfel Crunch Porridge', 'bowls', 990),
  ('Nanni Egg Drop', 'shokupan', 1090),
  ('Halloumi-Honey Drop', 'shokupan', 1290),
  ('Pastrami New York Style Drop', 'shokupan', 1390),
  ('Burrata Italia', 'shokupan', 1390),
  ('Kleine Süßkartoffel-Pommes + Dip', 'shokupan', 390),
  ('Süßkartoffel-Pancakes mit Halloumi', 'pancakes', 1290),
  ('Süßkartoffel-Pancakes mit Tofu & Avocado', 'pancakes', 1290),
  ('Süßkartoffel-Pancakes Vegan Greek', 'pancakes', 1290),
  ('Süßkartoffel-Pancakes Apple Lotus', 'pancakes', 1190),
  ('Avocado & Poached Egg', 'bagels', 990),
  ('Smoky Tofu Bagel', 'bagels', 990),
  ('Sucuk Egg Bagel', 'bagels', 990),
  ('Egg Bagel', 'bagels', 890),
  ('Salmon Bagel', 'bagels', 1090),
  ('Golden Goat Club Sandwich', 'lunch', 1490),
  ('Chicken Karaage Burger', 'lunch', 1550),
  ('Avocado-Halloumi Burger', 'lunch', 1550),
  ('Süßkartoffel-Pommes mit Dip', 'lunch', 690),
  ('Classic French Toast', 'sweets', 1250),
  ('Classy Berry Pancakes', 'sweets', 1190),
  ('Bueno Berry Pancakes', 'sweets', 1190),
  ('Nannis Vegan Banana Bread', 'sweets', 990),
  ('Classic Vegan', 'waffeln', 390),
  ('Banana Choc', 'waffeln', 690),
  ('Lotus Crunch', 'waffeln', 750),
  ('White Bueno Crunch', 'waffeln', 790),
  ('Heiße Liebe', 'waffeln', 590),
  ('Kirschtraum', 'waffeln', 690),
  ('Oreo Berry Banana', 'waffeln', 750);
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
  ('waffeln', 'Ahornsirup', 100);
commit;

-- Theken-Schlüssel erzeugen. Das Ergebnis unten kopieren und sicher aufbewahren, es wird nur dieses eine Mal angezeigt.
select theke_schluessel_neu() as theken_schluessel;
