// Verbindung zur Bestell-Datenbank.
// Auf dem eigenen Rechner (npm start) antwortet der Testserver unter derselben Adresse.
// Für den echten Betrieb kommen hier die Adresse und der öffentliche Schlüssel des eigenen Supabase-Projekts hinein.
(() => {
  const lokal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const url = lokal ? '' : 'https://kpgabhgmstwbackbilcu.supabase.co';
  const key = lokal ? '' : 'sb_publishable_IFyw97KtbU8t3JX5YzDMzQ_OTBDoyYU';   // öffentlicher (publishable) Schlüssel, darf im Browser stehen
  if (!lokal && !url) return;    // noch nicht eingerichtet: die Karte bleibt eine Lesekarte
  // Zufällige Kennung dieses Geräts. Sie wird zusammen mit dem Passwort geschickt, damit die Datenbank
  // ein schon angemeldetes Gerät wiedererkennt und es von der Sperre nach Fehlversuchen ausnimmt.
  let geraet = '';
  try {
    geraet = localStorage.getItem('nanni:geraet') || '';
    if (!geraet) {
      geraet = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('nanni:geraet', geraet);
    }
  } catch { /* privater Modus: dann ohne Kennung */ }
  window.NANNI = {
    async rpc(funktion, werte) {
      if (geraet && werte && typeof werte.p_key === 'string') werte = { ...werte, p_key: werte.p_key + '\u001f' + geraet };
      const kopf = { 'content-type': 'application/json' };
      if (key) { kopf.apikey = key; kopf.authorization = 'Bearer ' + key; }
      const antwort = await fetch(url + '/rest/v1/rpc/' + funktion, { method: 'POST', headers: kopf, body: JSON.stringify(werte || {}), cache: 'no-store', credentials: 'omit' });   // omit: es werden keine Cookies gesendet oder angenommen
      if (!antwort.ok) throw new Error(funktion + ' ' + antwort.status);
      return antwort.json();
    }
  };
})();
