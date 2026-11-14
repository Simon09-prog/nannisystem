// Aktueller Stand der Karte.
//
// Die Karte steht fest in der Website (gebaut aus menu.json), damit sie sofort da ist und auch ohne Datenbank lesbar bleibt.
// Dieses Skript holt danach den gültigen Stand aus der Datenbank und gleicht die Seite an:
// Preise, Namen und Beschreibungen ändern, ausgeblendete Artikel entfernen, neue Artikel und Extras ergänzen.
// Gepflegt wird der Stand im Chef-Bereich der Einstellungen.
// Läuft auf der Kartenseite und auf der Startseite. gast.js wartet auf window.NANNI_KARTE, bevor es die Plus-Knöpfe setzt.
window.NANNI_KARTE = (async () => {
  if (!window.NANNI) return;
  let stand;
  try { stand = await window.NANNI.rpc('karte_stand'); } catch { return; }   // Datenbank nicht erreichbar: die feste Karte bleibt stehen
  if (!stand || !Array.isArray(stand.artikel) || !stand.artikel.length) return;

  const englisch = window.NANNI_SPRACHE === 'en';
  const T = window.NANNI_T || (text => text);
  const euro = cent => (cent / 100).toFixed(2).replace('.', ',') + ' €';
  const titel = a => englisch ? (a.name_en || T(a.titel || a.name)) : (a.titel || a.name);
  const text = a => englisch ? (a.beschreibung_en || T(a.beschreibung)) : a.beschreibung;
  const element = (tag, klasse, inhalt) => { const n = document.createElement(tag); if (klasse) n.className = klasse; if (inhalt != null) n.textContent = inhalt; return n; };

  function zeileFuellen(li, a) {
    li.dataset.p = a.preis_cent;
    li.querySelector('.mi-price').textContent = euro(a.preis_cent);
    // Der Name ist der erste Text in der Überschrift; dahinter können Marken wie "vegan" stehen
    const h4 = li.querySelector('h4');
    const name = titel(a) + (h4.children.length ? ' ' : '');
    if (h4.firstChild && h4.firstChild.nodeType === 3) h4.firstChild.nodeValue = name; else h4.prepend(name);
    let p = li.querySelector(':scope > p');
    const beschreibung = text(a);
    if (beschreibung) { if (!p) { p = element('p'); li.append(p); } p.textContent = beschreibung; }
    else if (p) p.remove();
  }

  // ---------- Artikel, die schon auf der Seite stehen
  const nachName = new Map(stand.artikel.map(a => [a.name, a]));
  const gesehen = new Set();
  for (const li of document.querySelectorAll('.mi[data-n]')) {
    const a = nachName.get(li.dataset.n);
    if (!a) { li.remove(); continue; }   // ausgeblendet oder gelöscht
    gesehen.add(a.name);
    zeileFuellen(li, a);
  }

  // Der Bereich einer Kategorie: auf der Kartenseite <section id="kaffee">, auf der Startseite <details id="k-kaffee">
  const bereich = kategorie => document.getElementById(kategorie)?.classList.contains('kcat')
    ? document.getElementById(kategorie) : document.getElementById('k-' + kategorie);

  // ---------- Neue Artikel aus dem Chef-Bereich ans Ende ihrer Kategorie
  for (const a of stand.artikel) {
    if (gesehen.has(a.name)) continue;
    const listen = bereich(a.kategorie)?.querySelectorAll('.mi-list');
    if (!listen || !listen.length) continue;
    const li = element('li', 'mi');
    li.dataset.n = a.name;
    const kopf = element('div', 'mi-top');
    const linie = element('span', 'mi-line'); linie.setAttribute('aria-hidden', 'true');
    kopf.append(element('h4', '', ''), linie, element('span', 'mi-price', ''));
    li.append(kopf);
    zeileFuellen(li, a);
    listen[listen.length - 1].append(li);
  }

  // ---------- Extras je Kategorie
  const kategorien = new Set([...stand.artikel.map(a => a.kategorie), ...stand.extras.map(x => x.kategorie)]);
  for (const kategorie of kategorien) {
    const ort = bereich(kategorie);
    if (!ort) continue;
    const soll = new Map(stand.extras.filter(x => x.kategorie === kategorie).map(x => [x.name, x]));
    const extraFuellen = (li, x) => {
      li.dataset.n = x.name; li.dataset.p = x.preis_cent;
      li.replaceChildren(T(x.name) + ' ', element('span', '', '+' + euro(x.preis_cent)));
    };
    for (const li of ort.querySelectorAll('.extras li[data-n]')) {
      const x = soll.get(li.dataset.n);
      if (!x) { li.remove(); continue; }
      extraFuellen(li, x);
      soll.delete(li.dataset.n);
    }
    if (!soll.size) continue;
    // Neue Extras: in den letzten vorhandenen Block, sonst einen neuen Block "Extras" anlegen
    let liste = [...ort.querySelectorAll('.extras ul')].pop();
    if (!liste) {
      const block = element('div', 'extras');
      liste = element('ul');
      block.append(element('b', '', 'Extras'), liste);
      const nach = [...ort.querySelectorAll('.mi-list')].pop();
      if (!nach) continue;
      nach.after(block);
    }
    for (const x of soll.values()) { const li = element('li'); extraFuellen(li, x); liste.append(li); }
  }
  // Leere Extra-Blöcke nicht stehen lassen
  for (const block of document.querySelectorAll('.extras')) if (!block.querySelector('li')) block.remove();
})();
