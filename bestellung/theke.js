// Die Theke: hier kommen die Bestellungen an und werden angenommen, serviert oder abgelehnt.
//
// Zugang nur mit dem Theken-Schlüssel. Er kommt entweder einmal über den Link (theke.html#k=SCHLÜSSEL)
// oder wird im Feld eingetippt. Danach merkt sich dieses Gerät den Schlüssel.
// Die Seite fragt alle 3 Sekunden die Datenbank nach dem aktuellen Stand.
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

  // ------------------------------------------------------------ Schlüssel
  const MERK = 'nanni:theke-key';
  const ausLink = new URLSearchParams(location.hash.slice(1)).get('k');
  if (ausLink) {
    try { localStorage.setItem(MERK, ausLink); } catch { /* privater Modus */ }
    history.replaceState(null, '', location.pathname);   // Schlüssel aus der Adresszeile entfernen
  }
  let KEY = ausLink;
  try { KEY = KEY || localStorage.getItem(MERK); } catch { /* privater Modus */ }

  function torZeigen(fehler) {
    $('tor').hidden = false;
    $('tor-feld').hidden = !!KEY;
    $('tor-text').textContent = KEY
      ? 'Hier kommen die Bestellungen von den Tischen an. Tippt auf Starten, dann meldet sich das Gerät bei jeder neuen Bestellung mit einem Ton und der Bildschirm bleibt an.'
      : 'Gebt einmal den Theken-Schlüssel ein. Danach merkt sich dieses Gerät den Zugang.';
    $('tor-fehler').textContent = fehler || ''; $('tor-fehler').hidden = !fehler;
  }
  if (!window.NANNI) { torZeigen('Die Verbindung zur Datenbank ist noch nicht eingerichtet.'); $('tor-knopf').hidden = true; $('tor-feld').hidden = true; return; }
  torZeigen();

  $('tor-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    tonAn();   // muss direkt im Tipp passieren, sonst erlaubt der Browser später keinen Ton
    const probe = KEY || $('tor-key').value.trim();
    if (!probe) return;
    $('tor-knopf').disabled = true;
    try {
      const antwort = await NANNI.rpc('theke_bestellungen', { p_key: probe });
      if (!antwort.ok) {
        KEY = null; try { localStorage.removeItem(MERK); } catch { /* egal */ }
        torZeigen('Dieser Schlüssel stimmt nicht.');
      } else {
        KEY = probe; try { localStorage.setItem(MERK, KEY); } catch { /* egal */ }
        $('tor-key').value = '';
        $('tor').hidden = true;
        gong(); wachBleiben(); uebernehmen(antwort); abfragen();
      }
    } catch { torZeigen('Keine Verbindung. Prüft das WLAN und versucht es noch einmal.'); }
    $('tor-knopf').disabled = false;
  });

  // ------------------------------------------------------------ Ton und Bildschirm
  // Der Gong wird hier im Browser als kleine Tondatei errechnet, es braucht keine mp3.
  // Er läuft über ein normales <audio>-Element: das klingt auf dem iPad auch dann,
  // wenn das Gerät auf "lautlos" steht (nur die Lautstärke muss aufgedreht sein).
  function gongDatei() {
    const rate = 22050, laenge = 1.5, daten = new Int16Array(rate * laenge);
    for (const [hz, ab] of [[880, 0], [1175, .18], [880, .7], [1175, .88]]) {
      for (let i = 0; i < rate * .6; i++) {
        const t = i / rate, ort = Math.floor(ab * rate) + i;
        if (ort >= daten.length) break;
        const huelle = Math.min(1, t / .01) * Math.exp(-t * 7);   // schnell an, weich aus
        daten[ort] += Math.sin(2 * Math.PI * hz * t) * huelle * 14000;
      }
    }
    const kopf = new DataView(new ArrayBuffer(44)), text = (ab, s) => [...s].forEach((c, i) => kopf.setUint8(ab + i, c.charCodeAt(0)));
    text(0, 'RIFF'); kopf.setUint32(4, 36 + daten.byteLength, true); text(8, 'WAVEfmt ');
    kopf.setUint32(16, 16, true); kopf.setUint16(20, 1, true); kopf.setUint16(22, 1, true);
    kopf.setUint32(24, rate, true); kopf.setUint32(28, rate * 2, true); kopf.setUint16(32, 2, true); kopf.setUint16(34, 16, true);
    text(36, 'data'); kopf.setUint32(40, daten.byteLength, true);
    return URL.createObjectURL(new Blob([kopf, daten], { type: 'audio/wav' }));
  }
  const ton = new Audio(gongDatei());
  ton.preload = 'auto';
  // Browser erlauben Ton erst nach einem Tipp. Darum wird er beim Tipp auf "Starten" einmal freigeschaltet.
  function tonAn() { ton.muted = true; ton.play().then(() => { ton.pause(); ton.currentTime = 0; ton.muted = false; }).catch(() => { ton.muted = false; }); }
  function gong() { ton.muted = false; ton.currentTime = 0; ton.play().catch(() => { /* noch nicht freigeschaltet */ }); }
  async function wachBleiben() { try { await navigator.wakeLock?.request('screen'); } catch { /* nicht unterstützt */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && KEY && $('tor').hidden) { wachBleiben(); abfragen(); } });

  // ------------------------------------------------------------ Zustand
  let bestellungen = [], aktiv = true;
  let uhrFehler = 0;            // Unterschied zwischen der Uhr dieses Geräts und der Datenbank
  const gesehen = new Set();    // IDs, für die schon gegongt wurde
  let ersterAbruf = true, letzterGong = 0, fehlversuche = 0;

  const minuten = b => Math.max(0, Math.floor((Date.now() + uhrFehler - new Date(b.created_at)) / 60e3));
  const uhr = b => new Date(b.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';

  function uebernehmen(antwort) {
    uhrFehler = new Date(antwort.jetzt) - Date.now();
    bestellungen = antwort.bestellungen; aktiv = antwort.aktiv;
    const neue = bestellungen.filter(b => b.status === 'neu');
    const frisch = neue.filter(b => !gesehen.has(b.id));
    bestellungen.forEach(b => gesehen.add(b.id));
    // Gong bei jeder neuen Bestellung, danach alle 20 Sekunden, solange etwas unangenommen wartet
    if ((frisch.length && !ersterAbruf) || (neue.length && Date.now() - letzterGong > 20e3)) { gong(); letzterGong = Date.now(); }
    if (frisch.length && !ersterAbruf) melden(frisch);
    ersterAbruf = false;
    zeichnen();
  }

  let wecker = null, unterwegs = false;
  async function abfragen() {
    clearTimeout(wecker);
    if (unterwegs || !KEY) return;
    unterwegs = true;
    try {
      const antwort = await NANNI.rpc('theke_bestellungen', { p_key: KEY });
      if (!antwort.ok) { unterwegs = false; KEY = null; try { localStorage.removeItem(MERK); } catch { /* egal */ } return torZeigen('Der Schlüssel gilt nicht mehr. Gebt bitte den aktuellen ein.'); }
      fehlversuche = 0; netz(true);
      uebernehmen(antwort);
    } catch { if (++fehlversuche >= 2) netz(false); }
    unterwegs = false;
    wecker = setTimeout(abfragen, 3000);
  }

  async function statusSetzen(b, status) {
    b.status = status; b.updated_at = new Date(Date.now() + uhrFehler).toISOString();
    zeichnen();   // sofort zeigen, nicht auf die Datenbank warten
    try { await NANNI.rpc('theke_status', { p_key: KEY, p_id: b.id, p_status: status }); } catch { netz(false); }
    abfragen();
  }

  // ------------------------------------------------------------ Anzeige
  function netz(ok) {
    $('netz').classList.toggle('aus', !ok);
    $('netz').lastElementChild.textContent = ok ? 'Verbunden' : 'Keine Verbindung';
    $('band-netz').hidden = ok;
  }

  // Einblendung oben: "Neue Bestellung · Tisch 3", verschwindet nach 8 Sekunden oder per Tipp
  let meldungWeg = null;
  function melden(frisch) {
    const m = $('meldung');
    m.replaceChildren(h('b', {}, frisch.length > 1 ? frisch.length + ' neue Bestellungen' : 'Neue Bestellung'),
      ' · ' + frisch.map(b => 'Tisch ' + b.tisch + (b.bereich ? ' ' + b.bereich : '')).join(', '));
    m.hidden = false;
    clearTimeout(meldungWeg); meldungWeg = setTimeout(() => { m.hidden = true; }, 8000);
  }
  $('meldung').addEventListener('click', () => { $('meldung').hidden = true; });
  $('ton-test').addEventListener('click', gong);

  // Ablehnen braucht zwei Tipps: der Knopf fragt erst nach, statt ein Fenster zu öffnen
  function ablehnKnopf(b) {
    let sicher = false, zurueck = null;
    const knopf = h('button', { type: 'button', class: 'zweit', onclick: () => {
      if (sicher) return statusSetzen(b, 'abgelehnt');
      sicher = true; knopf.textContent = 'Wirklich ablehnen?'; knopf.classList.add('warn');
      zurueck = setTimeout(() => { sicher = false; knopf.textContent = 'Ablehnen'; knopf.classList.remove('warn'); }, 4000);
    } }, 'Ablehnen');
    return knopf;
  }

  function karte(b) {
    const m = minuten(b), fertig = b.status === 'serviert' || b.status === 'abgelehnt';
    const knoepfe = b.status === 'neu'
      ? [h('button', { type: 'button', onclick: () => statusSetzen(b, 'angenommen') }, 'Annehmen'), ablehnKnopf(b)]
      : b.status === 'angenommen'
        ? [h('button', { type: 'button', onclick: () => statusSetzen(b, 'serviert') }, 'Serviert'),
           h('button', { type: 'button', class: 'zweit', onclick: () => statusSetzen(b, 'neu') }, 'Zurück')]
        : [h('button', { type: 'button', class: 'zweit', onclick: () => statusSetzen(b, 'angenommen') }, b.status === 'abgelehnt' ? 'Doch annehmen' : 'Zurückholen')];
    return h('article', { class: 'karte' + (b.status === 'neu' && m >= 3 ? ' spaet' : ''), 'data-stand': b.status },
      h('div', { class: 'karte-kopf' },
        h('b', {}, 'Tisch ' + b.tisch),
        h('span', { class: 'ort' }, b.bereich && h('span', { class: /drau/i.test(b.bereich) && 'aussen' }, b.bereich)),
        h('time', {}, fertig ? uhr(b) : (m < 1 ? 'gerade eben' : 'vor ' + m + ' Min'))),
      h('ul', { class: 'posten' }, b.positionen.map(p => h('li', {},
        h('span', { class: 'menge' }, p.menge + ' ×'),
        h('span', { class: 'name' }, p.name,
          p.extras.length > 0 && h('span', { class: 'extra' }, '+ ' + p.extras.map(x => x.name).join(', ')),
          p.notiz && h('span', { class: 'wunsch' }, p.notiz))))),
      h('div', { class: 'fuss' }, h('span', {}, 'Nr. ' + b.nr + ' · ' + uhr(b)), h('span', {}, euro(b.summe_cent))),
      h('div', { class: 'knoepfe' }, knoepfe));
  }

  function zeichnen() {
    const spalten = {
      'spalte-neu': [bestellungen.filter(b => b.status === 'neu'), 'Keine neuen Bestellungen.'],
      'spalte-arbeit': [bestellungen.filter(b => b.status === 'angenommen'), 'Nichts in Arbeit.'],
      'spalte-fertig': [bestellungen.filter(b => b.status === 'serviert' || b.status === 'abgelehnt')
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 40), 'Heute noch nichts erledigt.']
    };
    for (const [id, [liste, leer]] of Object.entries(spalten)) {
      const s = $(id);
      s.classList.toggle('voll', liste.length > 0);
      s.querySelector('header span').textContent = liste.length;
      s.querySelector('.karten').replaceChildren(...(liste.length ? liste.map(karte) : [h('p', { class: 'leer' }, leer)]));
    }
    const n = spalten['spalte-neu'][0].length;
    document.title = (n ? '(' + n + ') ' : '') + 'Theke – NANNI';
    $('schalter').setAttribute('aria-checked', aktiv);
    $('schalter-text').textContent = aktiv ? 'Bestellen am Handy ist an' : 'Bestellen am Handy ist aus';
    $('band-pause').hidden = aktiv;
  }

  // Schalter: Bestellen am Handy an/aus
  $('schalter').addEventListener('click', async () => {
    aktiv = !aktiv; zeichnen();
    try { await NANNI.rpc('theke_aktiv', { p_key: KEY, p_aktiv: aktiv }); } catch { netz(false); }
    abfragen();
  });

  zeichnen();
  setInterval(() => { if ($('tor').hidden) zeichnen(); }, 30e3);   // "vor x Min" aktuell halten
})();
