// Bestellen am Tisch: die Seite des Gastes.
//
// Ohne Code im Link (karte.html) passiert hier nichts, die Karte bleibt eine Lesekarte.
// Mit Code (karte.html?t=CODE) fragt das Skript die Datenbank, was der Code darf:
//   - Tisch-Code:  der Tisch steht fest (eigener Link je Tisch, z. B. auf einem NFC-Chip)
//   - Laden-Code:  ein gemeinsamer QR-Code für alle, der Gast trägt seine Tischnummer selbst ein
// Die Positionen liest es aus der Karte selbst (data-n = Name, data-p = Preis in Cent).
// Diese Preise sind nur für die Anzeige; verbindlich rechnet die Datenbank.
(() => {
  const code = new URLSearchParams(location.search).get('t');
  if (!code || !window.NANNI) return;

  // ------------------------------------------------------------ Helfer
  const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' €';
  const uhr = ms => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  const STUNDE = 3600e3;

  // h('button', { class: 'x', onclick: fn }, 'Text', kind) baut ein Element. Text wird nie als HTML gelesen.
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
  const zeichen = pfad => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', pfad); s.append(p);
    return s;
  };
  const PLUS = 'M8 3v10M3 8h10', MINUS = 'M3 8h10', KREUZ = 'M4 4l8 8M12 4l-8 8';

  // Merkt sich Warenkorb und Bestellungen auf dem Handy (übersteht Neuladen)
  const merken = {
    lesen(name, ersatz) { try { return JSON.parse(localStorage.getItem('nanni:' + name + ':' + code)) ?? ersatz; } catch { return ersatz; } },
    schreiben(name, wert) { try { localStorage.setItem('nanni:' + name + ':' + code, JSON.stringify(wert)); } catch { /* privater Modus */ } }
  };

  function hinweis(text) {
    document.getElementById('status')?.after(h('p', { class: 'nb-hinweis', style: 'margin:14px auto 0;max-width:30em;padding:10px 16px;border-radius:14px;background:#fff3c4;color:#5b4700;font-size:.92rem' }, text));
  }

  NANNI.rpc('tisch_info', { p_code: code })
    .then(info => info && info.ok ? starten(info) : hinweis('Dieser Bestell-Link gilt nicht mehr. Scannt den Code am Tisch bitte neu oder bestellt direkt bei uns.'))
    .catch(() => hinweis('Bestellen am Handy ist gerade nicht erreichbar. Bestellt bitte direkt bei uns.'));

  function starten(info) {
    document.head.append(h('link', { rel: 'stylesheet', href: 'bestellung/gast.css' }));

    // ---------------------------------------------------------- Zustand
    let korb = merken.lesen('korb', []);
    let bestellungen = merken.lesen('bestellungen', []).filter(b => Date.now() - b.zeit < 12 * STUNDE);
    // Beim Laden-Code merkt sich das Handy den gewählten Tisch für drei Stunden
    let tisch = info.wahl ? null : { name: info.tisch, bereich: info.bereich };
    if (info.wahl) {
      const alt = merken.lesen('tisch', null);
      if (alt && Date.now() - alt.zeit < 3 * STUNDE) tisch = info.tische.find(t => t.id === alt.id) || null;
    }
    const tischName = t => 'Tisch ' + t.name + (t.bereich ? ' · ' + t.bereich : '');
    const zeilenPreis = z => (z.cent + z.extras.reduce((s, x) => s + x.cent, 0)) * z.menge;
    const korbSumme = () => korb.reduce((s, z) => s + zeilenPreis(z), 0);
    const korbAnzahl = () => korb.reduce((s, z) => s + z.menge, 0);
    const zusatz = z => [...z.extras.map(x => x.name), z.notiz].filter(Boolean).join(' · ');
    const fertig = b => b.status === 'serviert' || b.status === 'abgelehnt';
    const offeneRechnung = () => bestellungen.some(b => !b.bezahlt && b.status !== 'abgelehnt');
    function korbSpeichern() { merken.schreiben('korb', korb); leisteZeichnen(); }

    // ---------------------------------------------------------- Tisch-Anzeige im Kopf
    const tischKnopf = h(info.wahl ? 'button' : 'span', { class: 'nb-tisch', type: info.wahl && 'button', onclick: () => info.wahl && info.aktiv && tischWaehlen() });
    function tischZeichnen() {
      tischKnopf.replaceChildren(h('b', {}, tisch ? tischName(tisch) : 'Tischnummer eintragen'),
        info.aktiv && h('span', {}, info.wahl && tisch ? 'ändern' : 'Bestellt direkt hier am Handy'));
    }
    tischZeichnen();
    document.getElementById('status').after(h('br'), tischKnopf);

    // ---------------------------------------------------------- Plus-Knöpfe in der Karte
    const knoepfe = new Map();   // Artikelname -> Knopf, damit er die Menge im Korb zeigen kann
    if (info.aktiv) {
      for (const bereich of document.querySelectorAll('.kcat')) {
        const extras = [...bereich.querySelectorAll('.extras li[data-n]')].map(li => ({ name: li.dataset.n, cent: +li.dataset.p }));
        for (const li of bereich.querySelectorAll('.mi[data-n]')) {
          const artikel = { name: li.dataset.n, cent: +li.dataset.p, text: li.querySelector('p')?.textContent || '', extras };
          const knopf = h('button', { class: 'nb-plus', type: 'button', 'aria-label': artikel.name + ' hinzufügen', onclick: () => artikelBlatt(artikel) });
          li.querySelector('.mi-top').append(knopf);
          knoepfe.set(artikel.name, knopf);
        }
      }
    } else {
      document.querySelector('.k-hero').append(h('p', { class: 'nb-pause' }, h('b', {}, 'Bestellen am Handy ist gerade pausiert.'), ' Bestellt bitte direkt bei uns an der Theke.'));
    }

    // ---------------------------------------------------------- Bausteine
    // Ein Blatt, das von unten hochkommt: Kopf, Inhalt (scrollt), Fuß (bleibt stehen)
    function blatt(titel, untertitel) {
      const inhalt = h('div', { class: 'nb-inhalt' }), fuss = h('div', { class: 'nb-fuss' });
      const d = h('dialog', { class: 'nb-blatt' },
        h('header', {}, h('div', {}, h('h3', {}, titel), untertitel && h('p', {}, untertitel)),
          h('button', { class: 'nb-zu', type: 'button', 'aria-label': 'Schließen', onclick: () => d.close() }, zeichen(KREUZ))),
        inhalt, fuss);
      d.addEventListener('click', ev => { if (ev.target === d) d.close(); });   // Tipp neben das Blatt schließt es
      d.addEventListener('close', () => d.remove());
      document.body.append(d);
      d.showModal();
      return { d, inhalt, fuss };
    }
    // Minus / Zahl / Plus
    function zaehler(start, min, beiAenderung) {
      let wert = start;
      const zahl = h('output', {}, String(wert));
      const schritt = n => { wert = Math.max(min, Math.min(20, wert + n)); zahl.textContent = wert; beiAenderung(wert); };
      return h('div', { class: 'nb-zaehler' },
        h('button', { type: 'button', 'aria-label': 'Weniger', onclick: () => schritt(-1) }, zeichen(MINUS)), zahl,
        h('button', { type: 'button', 'aria-label': 'Mehr', onclick: () => schritt(1) }, zeichen(PLUS)));
    }

    // ---------------------------------------------------------- Blatt: Artikel hinzufügen
    function artikelBlatt(artikel) {
      const b = blatt(artikel.name, artikel.text);
      let menge = 1;
      const haken = artikel.extras.map(x => ({ x, feld: h('input', { type: 'checkbox' }) }));
      const gewaehlt = () => haken.filter(k => k.feld.checked).map(k => k.x);
      if (haken.length) {
        b.inhalt.append(h('h4', {}, 'Extras'), h('ul', { class: 'nb-extras' },
          haken.map(k => h('li', {}, h('label', {}, k.feld, h('span', {}, k.x.name), h('em', {}, '+' + euro(k.x.cent)))))));
      }
      const wunsch = h('textarea', { rows: 2, maxlength: 200, placeholder: 'z. B. mit Hafermilch, koffeinfrei, ohne Zwiebeln' });
      b.inhalt.append(h('h4', {}, 'Wunsch dazu'), wunsch);

      const dazu = h('button', { class: 'nb-knopf', type: 'button', onclick: () => {
        const zeile = { name: artikel.name, cent: artikel.cent, menge, notiz: wunsch.value.trim(), extras: gewaehlt() };
        // Gleicher Artikel mit gleichen Extras und gleichem Wunsch: Menge erhöhen statt neue Zeile
        const gleich = korb.find(z => z.name === zeile.name && zusatz(z) === zusatz(zeile));
        if (gleich) gleich.menge = Math.min(20, gleich.menge + menge); else korb.push(zeile);
        korbSpeichern(); b.d.close();
      } });
      const preisZeigen = () => dazu.replaceChildren(h('span', {}, 'Hinzufügen'),
        h('span', {}, euro((artikel.cent + gewaehlt().reduce((s, x) => s + x.cent, 0)) * menge)));
      haken.forEach(k => k.feld.addEventListener('change', preisZeigen));
      b.fuss.append(h('div', { class: 'nb-reihe' }, zaehler(1, 1, m => { menge = m; preisZeigen(); }), dazu));
      preisZeigen();
    }

    // ---------------------------------------------------------- Blatt: Tisch wählen (nur beim Laden-Code)
    // Der Gast tippt seine Tischnummer ein. Gibt es die Nummer in mehreren Bereichen
    // (z. B. Tisch 1 drinnen und draußen), fragt das Blatt danach noch nach dem Bereich.
    function tischWaehlen(danach) {
      const b = blatt('An welchem Tisch sitzt ihr?', 'Die Nummer steht bei euch am Tisch.');
      if (!info.tische.length) return b.inhalt.append(h('p', {}, 'Es sind noch keine Tische eingerichtet. Bestellt bitte direkt bei uns.'));
      const nurZahlen = info.tische.every(t => /^\d+$/.test(t.name));
      const feld = h('input', { class: 'nb-nummer', type: 'text', inputmode: nurZahlen && 'numeric', maxlength: 20, autocomplete: 'off',
        'aria-label': 'Tischnummer', placeholder: 'Tischnummer', value: tisch ? tisch.name : null });
      const fehler = h('p', { class: 'nb-fehler', role: 'alert', hidden: true });
      const bereiche = h('div', { class: 'nb-bereiche' });
      const nehmen = t => {
        tisch = t; merken.schreiben('tisch', { id: t.id, zeit: Date.now() });
        tischZeichnen(); b.d.close(); danach?.();
      };
      const pruefen = () => {
        const eingabe = feld.value.trim().toLowerCase();
        const treffer = info.tische.filter(t => t.name.toLowerCase() === eingabe);
        bereiche.replaceChildren(); fehler.hidden = true;
        if (!eingabe) { fehler.textContent = 'Tragt bitte eure Tischnummer ein.'; fehler.hidden = false; return feld.focus(); }
        if (!treffer.length) { fehler.textContent = 'Diesen Tisch gibt es bei uns nicht. Schaut bitte noch einmal auf die Nummer am Tisch.'; fehler.hidden = false; return feld.focus(); }
        if (treffer.length === 1) return nehmen(treffer[0]);
        bereiche.append(h('h4', {}, 'Wo sitzt ihr?'), h('div', { class: 'nb-reihe' },
          treffer.map(t => h('button', { class: 'nb-knopf hell mitte', type: 'button', onclick: () => nehmen(t) }, t.bereich || 'Tisch ' + t.name))));
      };
      feld.addEventListener('input', () => { bereiche.replaceChildren(); fehler.hidden = true; });
      const form = h('form', { onsubmit: ev => { ev.preventDefault(); pruefen(); } }, feld, fehler, bereiche);
      b.inhalt.append(form);
      b.fuss.append(h('button', { class: 'nb-knopf mitte', type: 'button', onclick: pruefen }, 'Weiter'));
      feld.focus(); feld.select();
    }

    // ---------------------------------------------------------- Blatt: Warenkorb und Abschicken
    function korbBlatt() {
      const b = blatt('Eure Bestellung', !info.wahl && tischName(tisch));
      const liste = h('ul', { class: 'nb-zeilen' }), summe = h('b', {});
      const tischZeile = h('button', { class: 'nb-tischzeile', type: 'button', onclick: () => tischWaehlen(tischZeileZeichnen) });
      const tischZeileZeichnen = () => tischZeile.replaceChildren(h('b', {}, tisch ? tischName(tisch) : 'Euer Tisch'), h('span', {}, tisch ? 'ändern' : 'Nummer eintragen'));
      const fehler = h('p', { class: 'nb-fehler', role: 'alert', hidden: true });
      const senden = h('button', { class: 'nb-knopf mitte', type: 'button', onclick: abschicken }, 'Bestellung abschicken');

      function zeichnen() {
        if (!korb.length) return b.d.close();
        liste.replaceChildren(...korb.map(z => h('li', {},
          zaehler(z.menge, 0, m => { if (m === 0) korb = korb.filter(x => x !== z); else z.menge = m; korbSpeichern(); zeichnen(); }),
          h('div', { class: 'was' }, h('b', {}, z.name), zusatz(z) && h('small', {}, zusatz(z))),
          h('span', { class: 'preis' }, euro(zeilenPreis(z))))));
        summe.textContent = euro(korbSumme());
      }

      async function abschicken() {
        if (!tisch) return tischWaehlen(() => { tischZeileZeichnen(); abschicken(); });
        senden.disabled = true; senden.textContent = 'Wird gesendet …'; fehler.hidden = true;
        const scheitern = text => { fehler.textContent = text; fehler.hidden = false; senden.disabled = false; senden.textContent = 'Bestellung abschicken'; };
        let antwort;
        try {
          antwort = await NANNI.rpc('bestellung_aufgeben', {
            p_code: code, ...(info.wahl && { p_tisch: tisch.id }),
            p_positionen: korb.map(z => ({ name: z.name, menge: z.menge, notiz: z.notiz, extras: z.extras.map(x => ({ name: x.name })) }))
          });
        } catch { return scheitern('Keine Verbindung. Prüft kurz euer Netz und versucht es noch einmal.'); }
        if (!antwort.ok) {
          return scheitern({
            pausiert: 'Bestellen am Handy ist gerade pausiert. Bestellt bitte an der Theke.',
            zuviele: 'Von eurem Tisch warten schon Bestellungen bei uns. Einen Moment, wir sind gleich so weit.',
            tisch: 'Dieser Tisch-Link gilt nicht mehr. Scannt den Code am Tisch bitte noch einmal.',
            artikel: 'Unsere Karte hat sich gerade geändert. Ladet die Seite bitte neu und bestellt noch einmal.'
          }[antwort.fehler] || 'Das hat nicht geklappt. Bestellt bitte an der Theke.');
        }
        // Summe und Nummer kommen von der Datenbank, nicht aus der eigenen Rechnung
        bestellungen.unshift({ id: antwort.id, nr: antwort.nr, zeit: Date.now(), status: 'neu', summe: antwort.summe_cent, tisch: tischName(tisch),
          zeilen: korb.map(z => ({ menge: z.menge, name: z.name, zusatz: zusatz(z) })) });
        merken.schreiben('bestellungen', bestellungen);
        korb = []; korbSpeichern(); b.d.close();
        standBlatt(); standAbfragen();
      }

      tischZeileZeichnen();
      b.inhalt.append(liste);
      b.fuss.append(info.wahl && tischZeile, h('div', { class: 'nb-summe' }, h('span', {}, 'Summe'), summe), fehler,
        h('p', { class: 'nb-klein' }, 'Bezahlt wird wie gewohnt bei uns im Café.'), senden);
      zeichnen();
    }

    // ---------------------------------------------------------- Blatt: Stand der Bestellungen
    const STAND = {
      neu: ['Ist bei uns angekommen', 'Wir schauen gleich drauf.'],
      angenommen: ['Wird gerade zubereitet', 'Wir bringen es euch an den Tisch.'],
      serviert: ['Serviert', 'Lasst es euch schmecken.'],
      abgelehnt: ['Konnten wir nicht annehmen', 'Kommt bitte kurz zu uns an die Theke.']
    };
    const BEZAHLT = ['Bezahlt', 'Danke für euren Besuch.'];
    const stand = b => b.bezahlt ? BEZAHLT : STAND[b.status];
    let standListe = null;   // nur gesetzt, solange das Blatt offen ist
    function standZeichnen() {
      standListe?.replaceChildren(...bestellungen.map(b => h('article', { class: 'nb-bestellung', 'data-stand': b.status },
        h('header', {}, h('i'), h('b', {}, stand(b)[0]), h('small', {}, 'Nr. ' + b.nr + ' · ' + uhr(b.zeit))),
        h('p', {}, stand(b)[1]),
        h('ul', {}, b.zeilen.map(z => h('li', {}, z.menge + ' × ' + z.name, z.zusatz && h('small', {}, ' · ' + z.zusatz)))),
        h('footer', {}, h('span', {}, b.tisch), h('span', {}, euro(b.summe))))));
    }
    function standBlatt() {
      const b = blatt('Eure Bestellungen', 'Bezahlt wird wie gewohnt bei uns im Café.');
      standListe = b.inhalt; standZeichnen();
      b.d.addEventListener('close', () => { standListe = null; });
      // "Wir möchten zahlen": sagt der Theke Bescheid. Bezahlt wird beim Personal oder an der Theke.
      const bescheid = () => h('p', { class: 'nb-bescheid' }, h('b', {}, 'Wir wissen Bescheid.'), ' Wir kommen gleich zu euch, oder ihr zahlt direkt an der Theke.');
      const zahlFehler = h('p', { class: 'nb-fehler', role: 'alert', hidden: true });
      const zahlKnopf = h('button', { class: 'nb-knopf mitte', type: 'button', onclick: zahlen }, 'Wir möchten zahlen');
      async function zahlen() {
        if (!tisch) return tischWaehlen(zahlen);
        zahlKnopf.disabled = true; zahlFehler.hidden = true;
        try {
          const antwort = await NANNI.rpc('zahlen_wuenschen', { p_code: code, ...(info.wahl && { p_tisch: tisch.id }) });
          if (antwort.ok) { merken.schreiben('zahlen', Date.now()); return zahlKnopf.replaceWith(bescheid()); }
          zahlFehler.textContent = antwort.fehler === 'nichts' ? 'An eurem Tisch ist nichts mehr offen.' : 'Das hat nicht geklappt. Kommt bitte kurz zu uns an die Theke.';
        } catch { zahlFehler.textContent = 'Keine Verbindung. Versucht es noch einmal oder kommt zu uns an die Theke.'; }
        zahlFehler.hidden = false; zahlKnopf.disabled = false;
      }
      if (offeneRechnung()) b.fuss.append(Date.now() - merken.lesen('zahlen', 0) < 3 * STUNDE ? bescheid() : zahlKnopf, zahlFehler);
      b.fuss.append(h('button', { class: 'nb-knopf hell mitte', type: 'button', onclick: () => b.d.close() }, 'Weiter in der Karte'));
    }

    // Regelmäßig nachfragen, solange etwas offen ist und die Seite sichtbar ist
    let wecker = null;
    async function standAbfragen() {
      clearTimeout(wecker);
      // Nachfragen, bis alles bezahlt oder abgelehnt ist: zügig, solange noch etwas in Arbeit ist, sonst gemächlich
      const offen = bestellungen.filter(b => !b.bezahlt && b.status !== 'abgelehnt');
      if (!offen.length) merken.schreiben('zahlen', 0);
      if (!offen.length || document.hidden) return;
      try {
        const antwort = await NANNI.rpc('bestellung_status', { p_ids: offen.map(b => b.id) });
        let neu = false;
        for (const a of antwort) {
          const b = bestellungen.find(x => x.id === a.id);
          if (b && STAND[a.status] && (b.status !== a.status || !!b.bezahlt !== !!a.bezahlt)) {
            b.status = a.status; b.bezahlt = !!a.bezahlt;
            if (fertig(b) && !b.fertigUm) b.fertigUm = Date.now();
            neu = true;
          }
        }
        if (neu) { merken.schreiben('bestellungen', bestellungen); leisteZeichnen(); standZeichnen(); }
      } catch { /* beim nächsten Mal wieder versuchen */ }
      wecker = setTimeout(standAbfragen, offen.some(b => !fertig(b)) ? 5000 : 15000);
    }
    document.addEventListener('visibilitychange', standAbfragen);

    // ---------------------------------------------------------- Leiste unten: Stand + Warenkorb
    const leiste = h('div', { class: 'nb-leiste' });
    document.body.append(leiste);
    function leisteZeichnen() {
      leiste.replaceChildren();
      const letzte = bestellungen[0];
      // Fertige Bestellungen verschwinden nach 15 Minuten aus der Leiste
      if (letzte && !(fertig(letzte) && Date.now() - (letzte.fertigUm || letzte.zeit) > 15 * 60e3)) {
        const offen = bestellungen.filter(b => !fertig(b)).length;
        leiste.append(h('button', { class: 'nb-stand', type: 'button', 'data-stand': letzte.status, onclick: standBlatt },
          h('i'), h('span', { class: 'text' }, h('b', {}, 'Bestellung Nr. ' + letzte.nr), ' · ' + stand(letzte)[0]),
          h('span', { class: 'mehr' }, offen > 1 ? offen + ' offen' : 'ansehen')));
      }
      if (korb.length && info.aktiv) {
        leiste.append(h('button', { class: 'nb-korb', type: 'button', onclick: korbBlatt },
          h('span', { class: 'anzahl' }, String(korbAnzahl())), h('span', { class: 'text' }, 'Bestellung ansehen'), h('span', {}, euro(korbSumme()))));
      }
      // Plus-Knöpfe zeigen, wie oft der Artikel schon im Korb liegt
      for (const [name, knopf] of knoepfe) {
        const n = korb.filter(z => z.name === name).reduce((s, z) => s + z.menge, 0);
        knopf.classList.toggle('voll', n > 0);
        knopf.replaceChildren(n > 0 ? String(n) : zeichen(PLUS));
      }
      // Platz unter der Seite freihalten, damit die Leiste nichts verdeckt
      document.body.classList.toggle('nb-mit-leiste', leiste.childElementCount > 0);
      document.body.style.setProperty('--nb-leiste', leiste.offsetHeight + 'px');
    }
    leisteZeichnen();
    standAbfragen();
    setInterval(leisteZeichnen, 60e3);
  }
})();
