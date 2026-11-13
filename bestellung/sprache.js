// Sprache der Karte: Deutsch oder Englisch.
// Beim ersten Besuch entscheidet die Sprache des Handys (alles außer Deutsch bekommt Englisch),
// danach gilt, was der Gast mit dem Knopf oben gewählt hat.
// Die Seite selbst bleibt deutsch gebaut; für Englisch werden die Texte anhand von karte.en.js ersetzt.
(() => {
  let sprache = null;
  try { sprache = localStorage.getItem('nanni:sprache'); } catch { /* privater Modus */ }
  if (sprache !== 'de' && sprache !== 'en') sprache = (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
  const EN = sprache === 'en' ? (window.NANNI_EN || {}) : null;

  const MONATE = { Januar: 'January', Februar: 'February', 'März': 'March', April: 'April', Mai: 'May', Juni: 'June', Juli: 'July',
    August: 'August', September: 'September', Oktober: 'October', November: 'November', Dezember: 'December' };
  // Zusammengesetzte Texte, die nicht wörtlich im Wörterbuch stehen können
  const MUSTER = [
    [/^Tisch ([^·]+)$/, m => 'Table ' + m[1]],
    [/^Bestellung für (.+)$/, m => 'Order for ' + T(m[1])],
    [/^Bestellung Nr\. (\d+)$/, m => 'Order no. ' + m[1]],
    [/^Nr\. (\d+)$/, m => 'No. ' + m[1]],
    [/^(\d\d:\d\d) Uhr$/, m => m[1]],
    [/^(\d+) × (.+)$/, m => m[1] + ' × ' + T(m[2])],
    [/^(\d+) offen$/, m => m[1] + ' open'],
    [/^(.+) hinzufügen$/, m => 'Add ' + T(m[1])],
    [/^Wir kommen zu euch an (.+)\.$/, m => 'We will come to you at ' + T(m[1]) + '.'],
    [/^„(.+)“ ist leider gerade ausverkauft\. Nehmt es bitte aus der Bestellung\.$/, m => '“' + T(m[1]) + '” is sold out right now. Please remove it from your order.'],
    [/^bis (\d\d:\d\d) Uhr$/, m => 'until ' + m[1]],
    [/^öffnet um (\d\d:\d\d) Uhr$/, m => 'opens at ' + m[1]],
    [/^öffnet morgen um (\d\d:\d\d) Uhr$/, m => 'opens tomorrow at ' + m[1]],
    [/^Stand: ([^·]+)$/, m => 'As of ' + m[1].replace(/^[A-Za-zä]+/, monat => MONATE[monat] || monat)],
    [/^Preise in Euro inkl\. MwSt\.$/, () => 'Prices in euros incl. VAT'],
    [/^Allergene und Zusatzstoffe:$/, () => 'Allergens and additives:']
  ];

  // Übersetzt einen Text. Auf Deutsch (oder ohne Treffer) kommt er unverändert zurück.
  function T(text) {
    if (!EN || typeof text !== 'string') return text;
    const kern = text.trim();
    if (!kern) return text;
    const neu = wort(kern);
    return neu === kern ? text : text.replace(kern, () => neu);
  }
  function wort(kern) {
    if (Object.prototype.hasOwnProperty.call(EN, kern)) return EN[kern];
    for (const [muster, bauen] of MUSTER) { const m = kern.match(muster); if (m) return bauen(m); }
    // "Tisch 5 · Drinnen" oder "· Ist bei uns angekommen": die Teile einzeln übersetzen
    if (kern.includes(' · ')) return kern.split(' · ').map(T).join(' · ');
    if (kern.startsWith('· ')) return '· ' + T(kern.slice(2));
    if (kern.endsWith(' ·')) return T(kern.slice(0, -2)) + ' ·';
    return kern;
  }
  window.NANNI_SPRACHE = sprache;
  window.NANNI_T = T;

  function seiteUebersetzen() {
    document.documentElement.lang = sprache;
    if (EN) {
      const lauf = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement.closest('script, style, svg, dialog') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      });
      const knoten = [];
      while (lauf.nextNode()) knoten.push(lauf.currentNode);
      for (const n of knoten) { const neu = T(n.nodeValue); if (neu !== n.nodeValue) n.nodeValue = neu; }
      for (const el of document.querySelectorAll('[aria-label], img[alt]')) {
        for (const a of ['aria-label', 'alt']) if (el.hasAttribute(a)) el.setAttribute(a, T(el.getAttribute(a)));
      }
    }
    // Umschalter oben in der Karte
    const leiste = document.querySelector('.k-top');
    if (!leiste) return;
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.className = 'sprache';
    knopf.setAttribute('aria-label', sprache === 'en' ? 'Auf Deutsch anzeigen' : 'Show in English');
    for (const s of ['de', 'en']) {
      const teil = document.createElement(s === sprache ? 'b' : 'span');
      teil.textContent = s.toUpperCase();
      knopf.append(teil);
    }
    knopf.addEventListener('click', () => {
      try { localStorage.setItem('nanni:sprache', sprache === 'en' ? 'de' : 'en'); } catch { /* dann eben nicht merken */ }
      location.reload();
    });
    leiste.firstElementChild.after(knopf);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', seiteUebersetzen); else seiteUebersetzen();
})();
