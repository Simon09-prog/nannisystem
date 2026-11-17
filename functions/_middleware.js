// Hauptschalter für die ganze Website (läuft bei Cloudflare vor jeder einzelnen Seite und Datei).
// true  = nichts ist erreichbar: jede Adresse antwortet leer mit "nicht gefunden"
// false = die Website wird ganz normal ausgeliefert
const OFFLINE = false;

export const onRequest = (context) => {
  if (!OFFLINE) return context.next();
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' }
  });
};
