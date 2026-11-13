// Einstellungen für das Personal: Tagesübersicht, ausverkaufte Artikel, Öffnungszeiten,
// geschlossene Tage, Tische und der Bewertungslink.
// Zugang wie bei der Theke: Das Gerät muss den Theken-Schlüssel schon kennen.
(() => {
  const $ = id => document.getElementById(id);
  const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' €';
  function h(tag, props = {}, ...kinder) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kinder.flat().filter(k => k != null && k !== false));
    return n;
  }

  let KEY = null;
  try { KEY = localStorage.getItem('nanni:theke-key'); } catch { /* privater Modus */ }
  const sperren = text => { $('sperre').textContent = text; $('sperre').hidden = false; $('felder').hidden = true; };
  if (!window.NANNI) return sperren('Die Verbindung zur Datenbank ist noch nicht eingerichtet.');
  if (!KEY) return sperren('Zugang fehlt. Öffnet zuerst die Theke und gebt dort den Theken-Schlüssel ein.');

  let hinweisWeg = null;
  function hinweis(text) {
    $('hinweis').textContent = text; $('hinweis').hidden = false;
    clearTimeout(hinweisWeg); hinweisWeg = setTimeout(() => { $('hinweis').hidden = true; }, 4000);
  }
  // Jeder Aufruf schickt den Schlüssel mit; bei ungültigem Schlüssel wird die Seite gesperrt
  async function ruf(funktion, werte = {}) {
    try {
      const antwort = await NANNI.rpc(funktion, { p_key: KEY, ...werte });
      if (!antwort.ok && antwort.fehler === 'key') sperren('Der Schlüssel gilt nicht mehr. Öffnet die Theke und gebt den aktuellen ein.');
      return antwort;
    } catch { hinweis('Keine Verbindung. Versucht es gleich noch einmal.'); return { ok: false }; }
  }
  // Löschen braucht zwei Tipps
  function zweimal(knopf, text, tun) {
    let sicher = false, alt = knopf.textContent;
    knopf.addEventListener('click', () => {
      if (sicher) return tun();
      sicher = true; knopf.textContent = text; knopf.classList.add('warn');
      setTimeout(() => { sicher = false; knopf.textContent = alt; knopf.classList.remove('warn'); }, 4000);
    });
    return knopf;
  }

  // ------------------------------------------------------------ Heute
  async function tagLaden() {
    const t = await ruf('theke_tag');
    if (!t.ok) return;
    const kachel = (wert, name) => h('div', { class: 'kachel' }, h('b', {}, String(wert)), h('span', {}, name));
    $('tag-kacheln').replaceChildren(kachel(t.anzahl, 'Bestellungen'), kachel(euro(t.umsatz_cent), 'Umsatz am Handy bestellt'),
      kachel(t.tische, 'Tische'), kachel(t.abgelehnt, 'abgelehnt'));
    $('tag-top').replaceChildren(...(t.top.length
      ? t.top.map(x => h('li', {}, h('span', {}, x.name), h('b', {}, x.menge + ' ×')))
      : [h('li', { class: 'leer' }, 'Heute wurde noch nichts bestellt.')]));
  }
  $('tag-neu').addEventListener('click', tagLaden);

  // ------------------------------------------------------------ Ausverkauft
  let artikel = [], kategorien = {};
  async function artikelLaden() {
    // Die Namen der Kategorien stehen in der Karte (menu.json), die Datenbank kennt nur ihre Kürzel
    try { for (const k of (await (await fetch('menu.json', { cache: 'no-store' })).json()).kategorien) kategorien[k.id] = k.name; } catch { /* dann eben die Kürzel */ }
    const a = await ruf('theke_artikel');
    if (a.ok) { artikel = a.artikel; artikelZeichnen(); }
  }
  function artikelZeichnen() {
    const suche = $('artikel-suche').value.trim().toLowerCase();
    const sicht = artikel.filter(a => !suche || a.name.toLowerCase().includes(suche));
    const gruppen = [...new Set(sicht.map(a => a.kategorie))].sort((x, y) => Object.keys(kategorien).indexOf(x) - Object.keys(kategorien).indexOf(y));
    $('artikel').replaceChildren(...(sicht.length ? gruppen.map(g => h('div', { class: 'gruppe' },
      h('h3', {}, kategorien[g] || g),
      h('div', { class: 'chips' }, sicht.filter(a => a.kategorie === g).map(a =>
        h('button', { type: 'button', class: a.aus && 'aus', 'aria-pressed': String(a.aus), onclick: async () => {
          a.aus = !a.aus; artikelZeichnen();
          const r = await ruf('theke_ausverkauft', { p_name: a.name, p_aus: a.aus });
          if (!r.ok) { a.aus = !a.aus; artikelZeichnen(); }
        } }, a.name, a.aus && h('em', {}, 'ausverkauft')))))) : [h('p', { class: 'leer' }, 'Kein Artikel gefunden.')]));
  }
  $('artikel-suche').addEventListener('input', artikelZeichnen);

  // ------------------------------------------------------------ Öffnungszeiten, Ruhetage, Bewertungslink
  const TAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  let ruhetage = [];
  async function einstellungenLaden() {
    const e = await ruf('theke_einstellungen');
    if (!e.ok) return;
    $('zeiten').replaceChildren(...TAGE.map((name, i) => {
      const z = e.zeiten.find(x => x.tag === i + 1);
      const offen = h('input', { type: 'checkbox', checked: !!z, 'aria-label': name + ' geöffnet' });
      const von = h('input', { type: 'time', value: z ? z.von : '10:00', 'aria-label': name + ' von' });
      const bis = h('input', { type: 'time', value: z ? z.bis : '18:00', 'aria-label': name + ' bis' });
      const zeile = h('div', { class: 'tag' + (z ? '' : ' zu'), 'data-tag': i + 1 }, h('label', {}, offen, h('span', {}, name)), von, h('span', {}, 'bis'), bis);
      offen.addEventListener('change', () => zeile.classList.toggle('zu', !offen.checked));
      return zeile;
    }));
    ruhetage = e.ruhetage; ruhetageZeichnen();
    $('bewertung-url').value = e.bewertung_url;
  }
  $('zeiten-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const zeiten = [...$('zeiten').children].filter(z => z.querySelector('[type=checkbox]').checked).map(z => {
      const [von, bis] = [...z.querySelectorAll('[type=time]')].map(f => f.value);
      return { tag: +z.dataset.tag, von, bis };
    });
    if (zeiten.some(z => !z.von || !z.bis || z.von >= z.bis)) return hinweis('Bitte prüft die Zeiten: „von“ muss vor „bis“ liegen.');
    const r = await ruf('theke_zeiten_setzen', { p_zeiten: zeiten });
    hinweis(r.ok ? 'Öffnungszeiten gespeichert.' : 'Das hat nicht geklappt.');
  });

  const schoen = d => new Date(d + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  function ruhetageZeichnen() {
    $('ruhetage').replaceChildren(...(ruhetage.length ? ruhetage.map(d => h('li', {}, h('span', {}, schoen(d)),
      h('button', { type: 'button', class: 'klein-knopf', onclick: async () => { await ruf('theke_ruhetag', { p_datum: d, p_an: false }); einstellungenLaden(); } }, 'Entfernen')))
      : [h('li', { class: 'leer' }, 'Keine geschlossenen Tage eingetragen.')]));
  }
  $('ruhetag-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await ruf('theke_ruhetag', { p_datum: $('ruhetag-datum').value, p_an: true });
    if (r.ok) { $('ruhetag-datum').value = ''; einstellungenLaden(); }
  });
  $('bewertung-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await ruf('theke_bewertung', { p_url: $('bewertung-url').value.trim() });
    hinweis(r.ok ? 'Bewertungslink gespeichert.' : 'Der Link muss mit https:// beginnen.');
  });

  // ------------------------------------------------------------ Tische
  async function tischeLaden() {
    const t = await ruf('theke_tische');
    if (!t.ok) return;
    const bereiche = [...new Set(t.tische.map(x => x.bereich))];
    $('bereiche').replaceChildren(...bereiche.filter(Boolean).map(b => h('option', { value: b })));
    $('tische').replaceChildren(...(t.tische.length ? bereiche.map(b => h('div', { class: 'gruppe' },
      h('h3', {}, (b || 'Ohne Bereich') + ' · ' + t.tische.filter(x => x.bereich === b).length),
      h('div', { class: 'chips' }, t.tische.filter(x => x.bereich === b).map(x =>
        zweimal(h('button', { type: 'button', 'aria-label': 'Tisch ' + x.name + ' löschen' }, x.name), 'Löschen?',
          async () => { await ruf('theke_tisch_loeschen', { p_id: x.id }); tischeLaden(); })))))
      : [h('p', { class: 'leer' }, 'Noch keine Tische angelegt.')]));
  }
  $('tisch-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await ruf('theke_tisch_anlegen', { p_name: $('tisch-name').value.trim(), p_bereich: $('tisch-bereich').value.trim() });
    if (r.ok) { $('tisch-name').value = ''; tischeLaden(); }
    else if (r.fehler === 'doppelt') hinweis('Diesen Tisch gibt es in dem Bereich schon.');
  });

  $('felder').hidden = false;
  tagLaden(); artikelLaden(); einstellungenLaden(); tischeLaden();
})();
