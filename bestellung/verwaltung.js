// Einstellungen für das Personal.
//
// Zwei Zugänge:
//   - Theken-Schlüssel: darf Artikel als ausverkauft markieren (das braucht das Team im Alltag).
//   - Chef-Schlüssel:   darf zusätzlich Umsatz sehen, Öffnungszeiten, Tische und Schlüssel ändern.
// Solange noch kein Chef-Schlüssel erzeugt wurde, öffnet der Theken-Schlüssel alles.
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
  const merken = {
    lesen(name) { try { return localStorage.getItem(name); } catch { return null; } },
    schreiben(name, wert) { try { wert == null ? localStorage.removeItem(name) : localStorage.setItem(name, wert); } catch { /* privater Modus */ } }
  };

  let KEY = merken.lesen('nanni:theke-key');     // Theken-Schlüssel dieses Geräts
  let CHEF = merken.lesen('nanni:chef-key');     // Chef-Schlüssel, falls auf diesem Gerät hinterlegt
  const sperren = text => { $('sperre').textContent = text; $('sperre').hidden = false; $('felder').hidden = true; };
  if (!window.NANNI) return sperren('Die Verbindung zur Datenbank ist noch nicht eingerichtet.');

  let hinweisWeg = null;
  function hinweis(text) {
    $('hinweis').textContent = text; $('hinweis').hidden = false;
    clearTimeout(hinweisWeg); hinweisWeg = setTimeout(() => { $('hinweis').hidden = true; }, 4000);
  }
  // Aufruf mit dem Theken-Zugang (der Chef-Schlüssel gilt dort auch)
  async function ruf(funktion, werte = {}) {
    try {
      const antwort = await NANNI.rpc(funktion, { p_key: KEY || CHEF, ...werte });
      if (!antwort.ok && antwort.fehler === 'key') sperren('Der Schlüssel gilt nicht mehr. Öffnet die Theke und gebt den aktuellen ein.');
      return antwort;
    } catch { hinweis('Keine Verbindung. Versucht es gleich noch einmal.'); return { ok: false }; }
  }
  // Aufruf mit dem Chef-Zugang. Passt der Schlüssel nicht, wird der Chef-Bereich verriegelt.
  async function chef(funktion, werte = {}) {
    try {
      const antwort = await NANNI.rpc(funktion, { p_key: CHEF || KEY, ...werte });
      if (!antwort.ok && antwort.fehler === 'key') chefZu();
      return antwort;
    } catch { hinweis('Keine Verbindung. Versucht es gleich noch einmal.'); return { ok: false }; }
  }
  const chefBereiche = () => document.querySelectorAll('.feld.chef');
  function chefZu(text) {
    chefBereiche().forEach(f => { f.hidden = true; });
    $('chef-tor').hidden = false;
    $('chef-fehler').textContent = text || ''; $('chef-fehler').hidden = !text;
  }
  // Etwas Heikles braucht zwei Tipps
  function zweimal(knopf, frage, tun) {
    let sicher = false; const alt = knopf.textContent;
    knopf.addEventListener('click', () => {
      if (sicher) { sicher = false; knopf.textContent = alt; knopf.classList.remove('warn'); return tun(); }
      sicher = true; knopf.textContent = frage; knopf.classList.add('warn');
      setTimeout(() => { sicher = false; knopf.textContent = alt; knopf.classList.remove('warn'); }, 4000);
    });
    return knopf;
  }

  // ------------------------------------------------------------ Chef-Bereich entsperren
  $('chef-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const probe = $('chef-key').value.trim();
    if (!probe) return;
    try {
      const antwort = await NANNI.rpc('theke_einstellungen', { p_key: probe });
      if (!antwort.ok) return chefZu('Dieser Schlüssel passt nicht zum Chef-Bereich.');
      CHEF = probe; merken.schreiben('nanni:chef-key', CHEF);
      $('chef-key').value = '';
      chefAuf();
    } catch { chefZu('Keine Verbindung. Versucht es gleich noch einmal.'); }
  });
  $('chef-abmelden').addEventListener('click', () => { CHEF = null; merken.schreiben('nanni:chef-key', null); chefZu(); });

  async function chefAuf() {
    const e = await chef('theke_einstellungen');
    if (!e.ok) return;
    $('chef-tor').hidden = true;
    chefBereiche().forEach(f => { f.hidden = false; });
    einstellungenZeigen(e);
    tagLaden(); tischeLaden(); karteLaden();
  }

  // ------------------------------------------------------------ Heute
  async function tagLaden() {
    const t = await chef('theke_tag');
    if (!t.ok) return;
    const kachel = (wert, name) => h('div', { class: 'kachel' }, h('b', {}, String(wert)), h('span', {}, name));
    $('tag-kacheln').replaceChildren(kachel(t.anzahl, 'Bestellungen'), kachel(euro(t.umsatz_cent), 'Umsatz am Handy bestellt'),
      kachel(t.tische, 'Tische'), kachel(t.abgelehnt, 'abgelehnt'));
    $('tag-top').replaceChildren(...(t.top.length
      ? t.top.map(x => h('li', {}, h('span', {}, x.name), h('b', {}, x.menge + ' ×')))
      : [h('li', { class: 'leer' }, 'Heute wurde noch nichts bestellt.')]));
  }
  $('tag-neu').addEventListener('click', tagLaden);

  // ------------------------------------------------------------ Ausverkauft (Theken-Zugang)
  let artikel = [];
  const kategorien = {};
  // Die Namen der Kategorien stehen in der Karte (menu.json), die Datenbank kennt nur ihre Kürzel
  const kategorienGeladen = (async () => {
    try { for (const k of (await (await fetch('menu.json', { cache: 'no-store' })).json()).kategorien) kategorien[k.id] = k.name; } catch { /* dann eben die Kürzel */ }
  })();
  async function artikelLaden() {
    await kategorienGeladen;
    const a = await ruf('theke_artikel');
    if (a.ok) { artikel = a.artikel; artikelZeichnen(); }
  }
  function artikelZeichnen() {
    const suche = $('artikel-suche').value.trim().toLowerCase();
    const sicht = artikel.filter(a => !suche || a.name.toLowerCase().includes(suche));
    const folge = Object.keys(kategorien);
    const gruppen = [...new Set(sicht.map(a => a.kategorie))].sort((x, y) => folge.indexOf(x) - folge.indexOf(y));
    $('artikel').replaceChildren(...(sicht.length ? gruppen.map(g => h('div', { class: 'gruppe' },
      h('h3', {}, kategorien[g] || g),
      h('div', { class: 'chips' }, sicht.filter(a => a.kategorie === g).map(a =>
        h('button', { type: 'button', class: a.aus && 'aus', 'aria-pressed': String(a.aus), onclick: async () => {
          a.aus = !a.aus; artikelZeichnen();
          const r = await ruf('theke_ausverkauft', { p_name: a.name, p_aus: a.aus });
          if (!r.ok) { a.aus = !a.aus; artikelZeichnen(); }
        } }, a.titel || a.name, a.aus && h('em', {}, 'ausverkauft')))))) : [h('p', { class: 'leer' }, 'Kein Artikel gefunden.')]));
  }
  $('artikel-suche').addEventListener('input', artikelZeichnen);

  // ------------------------------------------------------------ Speisekarte pflegen (Chef-Zugang)
  let karte = { artikel: [], extras: [] };
  let inArbeit = null;   // der Artikel, der gerade im Dialog bearbeitet wird (null = neuer Artikel)
  const preisLesen = t => { const roh = String(t).replace('€', '').trim().replace(',', '.'); const z = Number(roh); return roh !== '' && isFinite(z) && z >= 0 ? Math.round(z * 100) : null; };
  const preisText = cent => (cent / 100).toFixed(2).replace('.', ',');
  const kat = () => $('karte-kat').value;

  async function karteLaden() {
    await kategorienGeladen;
    const k = await chef('chef_karte');
    if (!k.ok) return;
    karte = k;
    const vorher = kat();
    const ids = [...new Set([...Object.keys(kategorien), ...karte.artikel.map(a => a.kategorie)])].filter(id => karte.artikel.some(a => a.kategorie === id));
    $('karte-kat').replaceChildren(...ids.map(id => h('option', { value: id }, kategorien[id] || id)));
    if (ids.includes(vorher)) $('karte-kat').value = vorher;
    karteZeichnen();
  }
  function karteZeichnen() {
    const liste = karte.artikel.filter(a => a.kategorie === kat());
    $('karte-artikel').replaceChildren(...liste.map(a => h('li', { class: a.versteckt && 'aus' },
      h('button', { type: 'button', onclick: () => artikelDialog(a) },
        h('span', { class: 'name' }, a.titel || a.name, a.versteckt && h('span', { class: 'marke' }, 'ausgeblendet'), a.eigen && h('span', { class: 'marke neu' }, 'eigener Artikel')),
        h('span', { class: 'preis' }, preisText(a.preis_cent) + ' €')))));
    const extras = karte.extras.filter(x => x.kategorie === kat());
    $('karte-extras').replaceChildren(...(extras.length ? extras.map(x => {
      const feld = h('input', { value: preisText(x.preis_cent), inputmode: 'decimal', 'aria-label': 'Preis für ' + x.name });
      return h('li', {}, h('span', { class: 'name' }, x.name), feld,
        h('button', { type: 'button', class: 'klein-knopf', onclick: async () => {
          const cent = preisLesen(feld.value);
          if (cent == null) return hinweis('Bitte einen gültigen Preis eingeben, zum Beispiel 0,50.');
          const r = await chef('chef_extra_speichern', { p_kategorie: x.kategorie, p_name: x.name, p_preis_cent: cent });
          hinweis(r.ok ? 'Extra gespeichert.' : 'Das hat nicht geklappt.'); karteLaden();
        } }, 'Speichern'),
        zweimal(h('button', { type: 'button', class: 'klein-knopf' }, 'Löschen'), 'Wirklich?', async () => {
          await chef('chef_extra_loeschen', { p_kategorie: x.kategorie, p_name: x.name }); karteLaden();
        }));
    }) : [h('li', { class: 'leer' }, 'Diese Kategorie hat keine Extras.')]));
  }
  $('karte-kat').addEventListener('change', karteZeichnen);
  $('extra-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const cent = preisLesen($('extra-preis').value);
    if (cent == null) return hinweis('Bitte einen gültigen Preis eingeben, zum Beispiel 0,50.');
    const r = await chef('chef_extra_speichern', { p_kategorie: kat(), p_name: $('extra-name').value.trim(), p_preis_cent: cent });
    if (r.ok) { $('extra-name').value = ''; $('extra-preis').value = ''; karteLaden(); } else hinweis('Das hat nicht geklappt.');
  });

  function artikelDialog(a) {
    inArbeit = a;
    $('artikel-titel').textContent = a ? 'Artikel ändern' : 'Neuer Artikel · ' + (kategorien[kat()] || kat());
    $('f-name').value = a ? (a.titel || a.name) : '';
    $('f-preis').value = a ? preisText(a.preis_cent) : '';
    $('f-beschreibung').value = a ? a.beschreibung : '';
    $('f-name-en').value = a ? a.name_en : '';
    $('f-beschreibung-en').value = a ? a.beschreibung_en : '';
    $('f-versteckt').checked = !!(a && a.versteckt);
    $('artikel-loeschen').hidden = !(a && a.eigen);
    $('artikel-fehler').hidden = true;
    $('artikel-dialog').showModal();
  }
  $('karte-neu').addEventListener('click', () => artikelDialog(null));
  $('artikel-zu').addEventListener('click', () => $('artikel-dialog').close());
  $('artikel-dialog').addEventListener('click', ev => { if (ev.target === $('artikel-dialog')) $('artikel-dialog').close(); });
  zweimal($('artikel-loeschen'), 'Wirklich löschen?', async () => {
    await chef('chef_artikel_loeschen', { p_name: inArbeit.name });
    $('artikel-dialog').close(); karteLaden(); artikelLaden();
  });
  $('artikel-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const zeigen = t => { $('artikel-fehler').textContent = t; $('artikel-fehler').hidden = false; };
    const cent = preisLesen($('f-preis').value), name = $('f-name').value.trim();
    if (cent == null) return zeigen('Bitte einen gültigen Preis eingeben, zum Beispiel 3,90.');
    if (!name) return zeigen('Bitte einen Namen eingeben.');
    const daten = { preis_cent: cent, beschreibung: $('f-beschreibung').value, name_en: $('f-name-en').value,
      beschreibung_en: $('f-beschreibung-en').value, versteckt: $('f-versteckt').checked };
    let r;
    if (inArbeit) {
      // Der ursprüngliche Name bleibt der feste Schlüssel des Artikels; ein geänderter Name wird als Anzeigename gespeichert
      daten.titel = name === inArbeit.name ? '' : name;
      r = await chef('chef_artikel_speichern', { p_name: inArbeit.name, p_daten: daten });
    } else {
      if (karte.artikel.some(a => a.name.toLowerCase() === name.toLowerCase())) return zeigen('Einen Artikel mit diesem Namen gibt es schon.');
      daten.kategorie = kat();
      r = await chef('chef_artikel_speichern', { p_name: name, p_daten: daten });
    }
    if (!r.ok) return zeigen('Das hat nicht geklappt. Prüft bitte die Eingaben.');
    $('artikel-dialog').close();
    hinweis(inArbeit ? 'Artikel gespeichert.' : 'Artikel angelegt.');
    karteLaden(); artikelLaden();
  });

  // ------------------------------------------------------------ Öffnungszeiten, Ruhetage, Bewertungslink
  const TAGE = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  let ruhetage = [];
  function einstellungenZeigen(e) {
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
    // Zugänge: Hinweis, solange Theke und Chef noch denselben Schlüssel nutzen
    $('zugang-stand').textContent = e.chef_gesetzt
      ? 'Theke und Chef-Bereich haben getrennte Schlüssel.'
      : 'Im Moment öffnet der Theken-Schlüssel auch den Chef-Bereich. Erzeugt einen Chef-Schlüssel, um beides zu trennen.';
    $('chef-abmelden').hidden = !e.chef_gesetzt;
  }
  async function einstellungenLaden() { const e = await chef('theke_einstellungen'); if (e.ok) einstellungenZeigen(e); }
  $('zeiten-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const zeiten = [...$('zeiten').children].filter(z => z.querySelector('[type=checkbox]').checked).map(z => {
      const [von, bis] = [...z.querySelectorAll('[type=time]')].map(f => f.value);
      return { tag: +z.dataset.tag, von, bis };
    });
    if (zeiten.some(z => !z.von || !z.bis || z.von >= z.bis)) return hinweis('Bitte prüft die Zeiten: „von“ muss vor „bis“ liegen.');
    const r = await chef('theke_zeiten_setzen', { p_zeiten: zeiten });
    hinweis(r.ok ? 'Öffnungszeiten gespeichert.' : 'Das hat nicht geklappt.');
  });

  const schoen = d => new Date(d + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  function ruhetageZeichnen() {
    $('ruhetage').replaceChildren(...(ruhetage.length ? ruhetage.map(d => h('li', {}, h('span', {}, schoen(d)),
      h('button', { type: 'button', class: 'klein-knopf', onclick: async () => { await chef('theke_ruhetag', { p_datum: d, p_an: false }); einstellungenLaden(); } }, 'Entfernen')))
      : [h('li', { class: 'leer' }, 'Keine geschlossenen Tage eingetragen.')]));
  }
  $('ruhetag-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await chef('theke_ruhetag', { p_datum: $('ruhetag-datum').value, p_an: true });
    if (r.ok) { $('ruhetag-datum').value = ''; einstellungenLaden(); }
  });
  $('bewertung-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await chef('theke_bewertung', { p_url: $('bewertung-url').value.trim() });
    hinweis(r.ok ? 'Bewertungslink gespeichert.' : 'Der Link muss mit https:// beginnen.');
  });

  // ------------------------------------------------------------ Tische
  async function tischeLaden() {
    const t = await chef('theke_tische');
    if (!t.ok) return;
    const bereiche = [...new Set(t.tische.map(x => x.bereich))];
    $('bereiche').replaceChildren(...bereiche.filter(Boolean).map(b => h('option', { value: b })));
    $('tische').replaceChildren(...(t.tische.length ? bereiche.map(b => h('div', { class: 'gruppe' },
      h('h3', {}, (b || 'Ohne Bereich') + ' · ' + t.tische.filter(x => x.bereich === b).length),
      h('div', { class: 'chips' }, t.tische.filter(x => x.bereich === b).map(x =>
        zweimal(h('button', { type: 'button', 'aria-label': 'Tisch ' + x.name + ' löschen' }, x.name), 'Löschen?',
          async () => { await chef('theke_tisch_loeschen', { p_id: x.id }); tischeLaden(); })))))
      : [h('p', { class: 'leer' }, 'Noch keine Tische angelegt.')]));
  }
  $('tisch-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await chef('theke_tisch_anlegen', { p_name: $('tisch-name').value.trim(), p_bereich: $('tisch-bereich').value.trim() });
    if (r.ok) { $('tisch-name').value = ''; tischeLaden(); }
    else if (r.fehler === 'doppelt') hinweis('Diesen Tisch gibt es in dem Bereich schon.');
  });

  // ------------------------------------------------------------ Zugänge: Schlüssel neu erzeugen
  // Der neue Schlüssel wird genau einmal angezeigt. Die Datenbank speichert nur seinen Fingerabdruck.
  async function schluesselNeu(art) {
    const alt = CHEF || KEY;
    const r = await chef('schluessel_neu', { p_art: art });
    if (!r.ok) return hinweis('Das hat nicht geklappt.');
    if (art === 'chef') { CHEF = r.schluessel; merken.schreiben('nanni:chef-key', CHEF); }
    // Hat dieses Gerät den alten Theken-Schlüssel benutzt, merkt es sich gleich den neuen
    if (art === 'theke' && KEY) { KEY = r.schluessel; merken.schreiben('nanni:theke-key', KEY); }
    if (art === 'theke' && !KEY && alt === CHEF) { /* Chef-Gerät ohne Theken-Schlüssel: nichts zu merken */ }
    $('schluessel-titel').textContent = art === 'chef' ? 'Neuer Chef-Schlüssel' : 'Neuer Theken-Schlüssel';
    $('schluessel-wert').textContent = r.schluessel;
    $('schluessel-text').textContent = art === 'chef'
      ? 'Schreibt ihn jetzt ab oder speichert ihn sicher. Er wird nicht noch einmal angezeigt. Dieses Gerät merkt ihn sich.'
      : 'Schreibt ihn jetzt ab. Er wird nicht noch einmal angezeigt. Der alte Theken-Schlüssel gilt ab sofort nicht mehr; an jedem Theken-Gerät muss der neue einmal eingegeben werden.';
    $('schluessel-neu').hidden = false;
    $('schluessel-neu').scrollIntoView({ block: 'center' });
    einstellungenLaden();
  }
  zweimal($('neu-chef'), 'Wirklich neu erzeugen?', () => schluesselNeu('chef'));
  zweimal($('neu-theke'), 'Wirklich neu erzeugen?', () => schluesselNeu('theke'));
  $('schluessel-weg').addEventListener('click', () => { $('schluessel-wert').textContent = ''; $('schluessel-neu').hidden = true; });

  // ------------------------------------------------------------ Start
  $('felder').hidden = false;
  if (!KEY && !CHEF) {
    // Gerät kennt gar keinen Schlüssel: nur der Chef-Zugang kann hier weiterhelfen
    $('feld-ausverkauft').hidden = true;
    chefZu();
  } else {
    artikelLaden();
    // Passt der gemerkte Schlüssel zum Chef-Bereich? Sonst bleibt er zu, bis der Chef-Schlüssel eingegeben wird.
    NANNI.rpc('theke_einstellungen', { p_key: CHEF || KEY })
      .then(e => e.ok ? chefAuf() : chefZu())
      .catch(() => chefZu('Keine Verbindung. Ladet die Seite gleich noch einmal.'));
  }
})();
