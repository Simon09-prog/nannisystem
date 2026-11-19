-- Lunch Deal nur Mo–Mi und Fr 11:30–14:30, genau ein Getränk. Einmal im SQL-Editor von Supabase ausführen (Funktionen aus schema.sql).

create or replace function _lunchzeit() returns boolean
language sql stable security definer set search_path = public as $$
  select (select immer_offen from einstellungen) or (
    extract(isodow from now() at time zone 'Europe/Berlin') in (1, 2, 3, 5)
    and (now() at time zone 'Europe/Berlin')::time between time '11:30' and time '14:30')
$$;

create or replace function tisch_info(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e einstellungen; t tische;
begin
  select * into e from einstellungen;
  if p_code = e.laden_code then
    return jsonb_build_object('ok', true, 'wahl', true, 'aktiv', e.aktiv, 'offen', _offen(), 'lunch', _lunchzeit(), 'ausverkauft', _ausverkauft(), 'bewertung_url', e.bewertung_url, 'tische', coalesce(
      (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'bereich', bereich) order by bereich, length(name), name) from tische),
      '[]'::jsonb));
  end if;
  select * into t from tische where code = p_code;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'wahl', false, 'aktiv', e.aktiv, 'offen', _offen(), 'lunch', _lunchzeit(), 'ausverkauft', _ausverkauft(), 'bewertung_url', e.bewertung_url, 'tisch', t.name, 'bereich', t.bereich);
end $$;

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
    if a.kategorie = 'lunchdeal' and not _lunchzeit() then return jsonb_build_object('ok', false, 'fehler', 'lunchzeit', 'artikel', a.name); end if;

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
    -- Lunch Deal: genau ein Getränk muss gewählt sein
    if a.kategorie = 'lunchdeal' and (select count(*) from jsonb_array_elements(v_extras) j where j->>'name' like 'Getränk: %') <> 1 then
      return jsonb_build_object('ok', false, 'fehler', 'ungueltig');
    end if;

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
