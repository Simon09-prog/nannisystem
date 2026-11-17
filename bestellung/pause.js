// Pause-Schalter für die öffentliche Seite.
// true  = Startseite und Karte zeigen nur "Wir sind bald für euch da" (bald.html)
// false = alles ganz normal sichtbar
// Auch in der Pause erreichbar: die Karte über einen QR-Code am Tisch (Adresse mit ?t=...), Impressum und Datenschutz,
// Theke und Chef-Bereich.
(() => {
  const PAUSE = false;

  if (!PAUSE) return;
  const amTisch = new URLSearchParams(location.search).has('t');
  const rechtstext = location.hash === '#impressum' || location.hash === '#datenschutz';
  if (amTisch || rechtstext) return;
  document.documentElement.style.visibility = 'hidden';   // nichts von der Seite aufblitzen lassen
  location.replace('/bald');
})();
