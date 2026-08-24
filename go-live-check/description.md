# Go-Live-Check — finaler Funktionsrundgang vor dem Launch

**Wann:** unmittelbar vor jedem Go-Live, gegen die **Produktions-URL** nach dem Deploy —
zusätzlich zu, nicht statt [lighthouse-check](../lighthouse-check/description.md)
(Performance/SEO/A11y-Gate) und [security-check](../security-check/description.md)
(Header/CORS/Secrets/Infra). Dieser Check prüft, ob die Site **funktioniert und rechtlich
steht**: Monitoring sieht sie als gesund, Mails kommen an, der Cookie-Banner blockt Tracking
korrekt, Impressum/Datenschutz sind da und stimmen mit dem echten Setup überein, Formulare
holen eine echte Einwilligung ein, die Seite ist per Tastatur bedienbar, und die
Meta-/Sitemap-Basics stehen.

Reihenfolge: **Todo 1** Health-Endpoint → **Todo 2** SMTP-Kurzcheck → **Todo 3** Cookie-Banner
funktional → **Todo 4** Impressum, Datenschutz & Formular-Einwilligung → **Todo 5**
Barrierefreiheit-Tastaturrundgang → **Todo 6** SEO → **Todo 7** Rundgang.

---

## Todo 1: Health-Endpoint

Dokploy prüft per Default nur, ob der Container-Port antwortet — nicht, ob die App wirklich
funktioniert. Ein Next.js-Prozess, der läuft, aber keine DB-Verbindung mehr hat, bleibt so
„healthy", während die Site überall 500er wirft. Ein eigener Health-Endpoint schließt die
Lücke und ist die Basis für externes Uptime-Monitoring.

**Datei:** `src/app/api/health/route.ts` — **im Root-`app`-Baum**, außerhalb von
`(payload)`. Gleicher Grund wie bei der Auth-Route in [keycloak](../keycloak/description.md):
liegt daneben ein `(payload)/api/[...slug]/route.ts`-Catch-all, fängt der alles ab, wofür
keine spezifischere Route existiert — `/api/health` würde sonst bei Payload landen statt beim
eigenen Handler.

```ts
// src/app/api/health/route.ts
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import configPromise from '@payload-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getPayload({ config: configPromise })
    // Billige Query reicht — hier geht es nur um DB-Erreichbarkeit, nicht um Daten.
    await payload.find({ collection: 'users', limit: 1, depth: 0, select: {} })

    return NextResponse.json(
      { status: 'ok', timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'unknown' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
```

**`no-store` nicht vergessen.** Ohne den Header cacht Cloudflare/der Reverse-Proxy die letzte
Antwort — ein `200 ok` bleibt dann auch dann stehen, wenn die DB längst weg ist, und das
Monitoring meldet Grün auf einem toten Server.

**Bewusst schlank halten.** Kein `transporter.verify()` gegen den SMTP-Server im Health-Check —
das gehört in den separaten Testlauf aus [email-test](../email-test/description.md), nicht in
einen Endpoint, den Monitoring alle 30–60 s pollt. Ein kurz hängender Mailserver würde sonst den
Health-Check selbst blockieren und die App fälschlich als down melden.

**In Dokploy eintragen:** App → **Health Check Path** = `/api/health`. Ergänzend ein externer
Uptime-Monitor (z. B. UptimeRobot, Better Stack) auf dieselbe URL — Dokploys interner Check
startet nur den Container neu, meldet aber niemandem, dass etwas passiert ist.

---

## Todo 2: SMTP — Kurzcheck vor dem Launch

Vollständige Anleitung inklusive Laufzeit-Alarm in
[email-test](../email-test/description.md). Für den Go-Live reicht die Abnahme aus
[email-test Todo 4](../email-test/description.md#todo-4-abnahme) einmal frisch durchgespielt:

- [ ] `pnpm test:smtp --send=office@northlight.at` — `Authentication-Results` mit `spf=pass`,
      `dkim=pass`.
- [ ] Live-Formular auf der Produktions-URL einmal echt abgeschickt, mit Anhang.
- [ ] `ALERT_RESEND_API_KEY` / `ALERT_RESEND_FROM_EMAIL` in Dokploy gesetzt (eigener
      Agentur-Account, **nicht** der Kunden-Key) und der Alarm einmal provoziert.
- [ ] Kein Gate im Code, das auf `SMTP_HOST` prüft — sonst bleibt Resend als Fallback beim
      Providerwechsel unerreichbar (siehe
      [form-submissions-email](../form-submissions-email/description.md#falle-nie-auf-smtp_host-gaten)).

---

## Todo 3: Cookie-Banner — funktional prüfen

Die Architektur (c15t, Kategorien, `pushTrackingEvent`) steht in
[tracking](../tracking/description.md) — hier geht es um den **Funktionstest kurz vor Launch**,
im **privaten Fenster** (sonst greift ein alter Consent-Cookie aus der Entwicklung):

- [ ] Erster Seitenaufruf ohne bestehenden Consent: Banner erscheint, **bevor** irgendein
      Tracking-Request rausgeht. Im Network-Tab vor dem ersten Klick prüfen, dass **keine**
      Requests an `googletagmanager.com`, `google-analytics.com`, `connect.facebook.net` o. Ä.
      liegen.
- [ ] „Alle akzeptieren" → GTM/GA4/Pixel-Requests erscheinen. „Nur notwendig"/Ablehnen → sie
      bleiben dauerhaft aus, auch nach einem Reload.
- [ ] Footer-Button (`CookieButton`, siehe tracking.md) öffnet den Dialog erneut, mit der
      **zuvor getroffenen Auswahl vorbelegt** — nicht zurückgesetzt auf Default.
- [ ] Kontrast der Banner-Buttons geprüft (der c15t-Default reißt die Grenze regelmäßig, siehe
      [lighthouse-check](../lighthouse-check/description.md#was-in-diesen-projekten-typischerweise-hochkommt)).
- [ ] Bei mehrsprachigen Projekten: Banner-Texte in jeder aktiven Sprache kontrolliert, nicht
      nur in der Default-Locale.
- [ ] **SalesViewer-Sonderfall** (falls im Projekt aktiv): Laut tracking.md lädt es aktuell
      **unabhängig vom Consent-Status**. Vor Go-Live entscheiden — entweder technisch an c15t
      koppeln, oder in der Datenschutzerklärung (Todo 4) korrekt als consent-unabhängig
      deklarieren. Beides offen zu lassen ist der eigentliche Fehler.

---

## Todo 4: Impressum, Datenschutz & Formular-Einwilligung

Diese Seiten fehlen **nicht still** wie ein Mailfehler — ein 404 auf `/impressum` ist in
AT/DE ein eigenständiges Abmahnrisiko, kein Polish-Punkt. Der Check hier ist **technisch und
auf Konsistenz mit dem echten Setup**, nicht Rechtsberatung — der Text selbst kommt von
Kund:in oder Anwalt:in.

**Technisch:**

- [ ] Beide Seiten existieren als eigene Payload-Pages (gleiches Muster wie die „Erklärung zur
      Barrierefreiheit" in [accessibility §7](../accessibility/description.md)) und sind unter
      der Produktions-URL erreichbar — direkt aufrufen, nicht nur den Link im Footer
      voraussetzen.
- [ ] Bei mehrsprachigen Projekten: für **jede** aktive Locale vorhanden, inklusive korrekt
      lokalisierter Slugs (`/en/imprint`, `/en/privacy-policy` o. Ä.) — nicht nur die
      Default-Sprache mit Platzhalter in den restlichen.
- [ ] Im Footer verlinkt, neben der „Erklärung zur Barrierefreiheit" falls BFSG-pflichtig
      (siehe [accessibility](../accessibility/description.md)).
- [ ] Nicht versehentlich per `robots.txt` oder `noindex` blockiert — beide Seiten dürfen
      auffindbar sein.

**Inhaltlich — Vollständigkeits-, kein Formulierungs-Check:**

- [ ] **Impressum** enthält die Pflichtangaben (AT: § 5 ECG + ggf. § 25 MedienG bei
      redaktionellen Inhalten wie Blog/News; DE: § 5 TMG/DDG): Firmenname/Rechtsform, Adresse,
      Vertretungsberechtigte, Firmenbuch-/Handelsregisternummer, UID, Kontakt (E-Mail **und**
      Telefon), bei reglementierten Gewerben die Aufsichtsbehörde/Kammer.
- [ ] **Datenschutzerklärung nennt die tatsächlich eingesetzten Dienste** — Abgleich gegen das
      echte Tracking-Setup aus [tracking](../tracking/description.md): GTM, GA4, Meta Pixel,
      SalesViewer (mit dem Consent-Sonderfall aus Todo 3), plus Formular-Uploads/Speicherort
      (siehe [form-submissions-email](../form-submissions-email/description.md)) und
      Hosting-Standort (Hetzner). Ein Dienst, der im Code läuft, aber im Text fehlt (oder
      umgekehrt), ist der häufigste reale Fund hier — nicht eine fehlende Klausel.
- [ ] Cookie-Kategorien im Consent-Dialog (`necessary`/`marketing`/`measurement`/
      `experience`/`functionality`, siehe tracking.md) decken sich mit den in der
      Datenschutzerklärung beschriebenen Anbietern.

**Formular-Einwilligung (DSGVO-Checkbox):**

Jedes Formular, das personenbezogene Daten entgegennimmt (Kontakt, Bewerbung, Rückruf,
Newsletter), braucht eine eigene Einwilligung — der pauschale Hinweistext „Mit dem Absenden
stimmen Sie den Datenschutzbestimmungen zu" unter dem Button reicht nicht, wenn daneben eine
echte Checkbox stehen sollte, die aktiv angehakt werden muss.

- [ ] Checkbox vorhanden, **nicht vorausgewählt** (kein `defaultChecked`/`checked` im Markup),
      mit Link auf die echte Datenschutzerklärung von oben — nicht nur ein Fließtext-Verweis.
- [ ] Absenden **ohne** Haken schlägt serverseitig fehl, nicht nur clientseitig per
      `required`-Attribut wegklickbar. Gleicher Grund wie beim zeitbasierten Honeypot in
      [honey-pot-capcha](../honey-pot-capcha/description.md): eine rein clientseitige Prüfung
      lässt sich umgehen und schützt niemanden vor sich selbst.
- [ ] Fehlermeldung bei fehlendem Haken wird dem Feld zugeordnet und angesagt — Teil des
      „Formular leer absenden"-Tests aus
      [accessibility Punkt 4](../accessibility/description.md#6-manuelle-routine-pro-projekt-15-minuten)
      unten in Todo 5.
- [ ] Checkbox-Text benennt den Zweck der Verarbeitung (Kontaktaufnahme/Bewerbung/Newsletter),
      keine pauschale AGB-Floskel — sonst ist die Einwilligung rechtlich nicht informiert.
- [ ] Bei Newsletter-Anmeldung mit Double-Opt-In: Bestätigungsmail kommt an, Link bestätigt die
      Anmeldung tatsächlich (nicht nur UI-Zustand ohne Backend-Wirkung).

---

## Todo 5: Barrierefreiheit — Tastaturrundgang

Der volle Check inklusive Gate steht in [accessibility](../accessibility/description.md) und
ist im [lighthouse-check](../lighthouse-check/description.md)-Gate bereits als Untergrenze
enthalten. Vor Go-Live zusätzlich einmal **live** durchspielen, weil genau das automatisierte
Tools am zuverlässigsten übersehen:

- [ ] Die volle manuelle Routine aus
      [accessibility §6](../accessibility/description.md#6-manuelle-routine-pro-projekt-15-minuten)
      auf Start-, Formular- und einer Detailseite: nur Tastatur durch die Seite, Zoom 400 %,
      Screenreader-Struktur, Formular leer absenden, Alt-Texte, `prefers-reduced-motion`.
- [ ] **Pfeiltasten-Navigation in zusammengesetzten Widgets** — Dropdown-/Mobile-Menü, Tabs,
      Radio-Gruppen, Karussell/Slider, Custom-Select. WCAG erwartet dort das Arrow-Key-Pattern
      (roving `tabindex`), nicht nur einzelne Tab-Stopps durch jedes Element. Ein Menü, das sich
      nur mit `Tab` bedienen lässt, ist zwar erreichbar, verhält sich aber nicht wie erwartet —
      axe/Lighthouse melden das nicht, ein BITV-Test oder ein Screenreader-Nutzer sehr wohl.
- [ ] Cookie-Banner separat mitgetestet: komplett tastaturbedienbar, Fokus wandert beim
      Erscheinen hinein (siehe [accessibility §5.5](../accessibility/description.md) und Todo 3
      oben) — wird beim Testen erfahrungsgemäß vorher weggeklickt und dadurch übersprungen.
- [ ] Popup/Modal: mit `Escape` schließbar, Fokus geht danach dorthin zurück, wo er vor dem
      Öffnen war.

---

## Todo 6: SEO — finaler Check

Setup und Hintergründe stehen in [seo](../seo/description.md) (Fallbacks, Canonicals,
Sitemap-Pflicht pro Collection) und [seo-meta-check](../seo-meta-check/description.md)
(Meta-Defaults, OG-Bild-Auflösung, Admin-Dashboard). Vor Go-Live an einer Stichprobe
(Start, 2 Detailseiten, 1 Landingpage) gegenprüfen:

- [ ] Jede Seite hat einen **individuellen** `meta.title` (30–60 Zeichen) und
      `meta.description` (70–160 Zeichen) — kein leerer und kein doppelter Wert.
- [ ] Canonical-URL pro Seite korrekt, `/home` auf `/` normalisiert, Locale-Präfixe stimmen.
- [ ] OG-Bild ist **tatsächlich populiert** (1200×630), nicht überall das nie ersetzte
      Default-Bild — Ursache in der Regel der `depth`-Bug aus seo-meta-check.
- [ ] `curl https://domain.at/robots.txt | grep -i sitemap` — jede Collection mit öffentlicher
      Route hat ihren eigenen Sitemap-Eintrag, alle Locales enthalten; `<loc>`-Anzahl grob gegen
      die Zahl veröffentlichter Dokumente geprüft. `/admin` und `/api` ausgeschlossen, sonst
      **kein** `Disallow: /` auf dem Rest.
- [ ] `Media.alt` auf den Stichprobenseiten gesetzt, keine leeren Alt-Texte.
- [ ] Falls im Projekt vorhanden: `/admin/seo-check`-Dashboard einmal durchlaufen lassen, offene
      Findings vor Go-Live abgearbeitet oder bewusst akzeptiert.
- [ ] OG-Tags mit **Facebook Sharing Debugger** und **LinkedIn Post Inspector** gegengeprüft —
      beide cachen, nach Fixes Re-Scrape auslösen.
- [ ] `metadataBase` gesetzt, `<html lang>` korrekt, genau ein `<h1>` pro Seite.

---

## Todo 7: Rundgang

- [ ] `curl -I https://domain.at` — HTTPS aktiv, Security-Header vorhanden (siehe
      [security-check](../security-check/description.md)).
- [ ] Eigene, gebrandete 404-Seite — nicht Next.js-Default.
- [ ] Payload-Admin: Default-Passwort geändert (siehe
      [security-check §13](../security-check/description.md)).
- [ ] [lighthouse-check](../lighthouse-check/description.md)-Gate bestanden (SEO-Score darin
      ist die Kurzform von Todo 6, ersetzt es aber nicht).

---

## Checkliste

- [ ] `/api/health` liegt im Root-`app`-Baum, prüft DB-Erreichbarkeit, sendet `no-store`, ist
      in Dokploy als Health Check Path eingetragen — plus externer Uptime-Monitor.
- [ ] SMTP-Kurzcheck aus Todo 2 frisch gegen die Produktions-URL durchgespielt.
- [ ] Cookie-Banner blockt Tracking bis zur Zustimmung, Footer-Button funktioniert, Kontrast
      geprüft, SalesViewer-Sonderfall entschieden.
- [ ] Impressum und Datenschutz erreichbar, verlinkt, für alle Locales vorhanden und inhaltlich
      deckungsgleich mit dem echten Tracking-/Formular-/Hosting-Setup.
- [ ] Formulare mit personenbezogenen Daten haben eine nicht vorausgewählte, serverseitig
      geprüfte DSGVO-Einwilligungs-Checkbox mit Link auf die Datenschutzerklärung.
- [ ] Barrierefreiheits-Tastaturrundgang aus Todo 5 gemacht, inklusive Pfeiltasten-Navigation
      in zusammengesetzten Widgets und Cookie-Banner.
- [ ] SEO-Stichprobe aus Todo 6 geprüft: Meta-Titel/-Description individuell, OG-Bild populiert,
      Sitemap vollständig, `/admin/seo-check`-Findings abgearbeitet.
- [ ] Rundgang aus Todo 7 abgehakt.
