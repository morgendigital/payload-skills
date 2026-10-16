# payload-geo — Kundenseite an das GEO-Tool anbinden

`@morgendigital/payload-geo` ist die Schnittstelle zwischen einer Payload-Kundenseite und unserem
GEO-Tool (blackb0x). Das Plugin legt in der Kundenseite die KI-&-SEO-Einstellungen an, öffnet
abgesicherte Endpunkte unter `/api/geo/*`, über die das Tool Alt-Texte, Meta-Texte, FAQ und
Einstellungen einspielt (mit Protokoll und Rückgängig), und zählt Besuche, Bot-Abrufe, Anfragen und
Buchungsklicks aus KI als Tagessummen.

Abgrenzung: **Was** auf einer Seite für AI-Search richtig ist (Crawler-Zugang, Content Signals,
`@graph`, Redaktionsregeln), steht in [geo](../geo/description.md). Dieser Skill beschreibt nur das
Paket: Einbau, Versionen, Schema-Änderungen, Betrieb.

**Wann einsetzen:** jede Payload-Kundenseite, die im GEO-Tool als Projekt mit CMS „Payload" geführt
wird und bei der das Tool Kennzahlen abrufen oder Änderungen einspielen soll. Seiten ohne Payload
laufen im Tool über das Einbau-Script — nicht über dieses Paket.

Quelle der Wahrheit ist der Code in `geo-tool-ai/packages/payload-geo` (README, CHANGELOG, `src/`).
Pilot war Karlingerhof.

## 0. Versionen — was veröffentlicht ist und was nicht

| Version | Stand | Inhalt | Schema-Änderung |
| --- | --- | --- | --- |
| 0.1.0 | **nie veröffentlicht** (nur Pilot) | Global `geo-settings`, Collection `geo-changes`, `/api/geo/*` | — |
| 0.2.0 | veröffentlicht 04.10.2026 | Collection `geo-stats`, `geoTrack`, `/api/geo/collect` + `/stats`, `captureAiSource`, `geoInquiryHook` | **ja** — Erstinstallation: `geo-settings`, `geo-changes`, `geo-stats` |
| 0.2.1 | veröffentlicht 04.10.2026 | `geoTrack` zählt im Prozess statt per HTTP auf die eigene Domain | nein |
| 0.3.0 | veröffentlicht 05.10.2026 | Land des Besuchers (`geo-stats.country`) | **ja** — neues Feld `country` |
| 0.4.0 | veröffentlicht 15.10.2026 | Buchungsklicks (`trackBookingClicks`, `POST /api/geo/beacon`), `bookingPages`, FAQ-Einspielen (`faqField`); Meta/FAQ verweigert ohne Drafts (`drafts-required`), einsprachige Seiten im Manifest, `503` mit `code: 'api-disabled'` | **ja** — `geo-stats.kind` bekommt `booking-click` |
| 0.4.1 | veröffentlicht 16.10.2026 — **aktuell neueste** | Länder-Datenbank `@ip-location-db/geo-whois-asn-country` (CC0) statt der deprecated `dbip-country` (wird weiter gelesen, falls installiert) | nein |

→ Vor dem Einbau mit `pnpm view @morgendigital/payload-geo versions` prüfen, was verfügbar ist.

→ **0.3.0 meldet sich im Manifest als `0.2.1`** (`PLUGIN_VERSION` wurde nicht mit angehoben, erst
0.4.0 korrigiert das). Wer im Tool oder per `curl` die Version einer Seite prüft: `features` im
Manifest ist verlässlicher als `version`.

## 1. Installation aus GitHub Packages

Das Paket ist privat (`publishConfig.registry = https://npm.pkg.github.com`, `access: restricted`,
Konto `morgendigital`). In der Kundenseite:

```ini
# .npmrc
@morgendigital:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
pnpm add @morgendigital/payload-geo
pnpm add @ip-location-db/geo-whois-asn-country   # optional, siehe §4 (Land des Besuchers)
```

- `NODE_AUTH_TOKEN` = **Token (classic)** des Kontos `morgendigital` mit `read:packages`.
  Fine-grained-Tokens funktionieren mit GitHub Packages nicht. Lokal in der Shell bzw. `.env`, in
  Dokploy als Umgebungsvariable, die **beim Build** verfügbar ist — sonst scheitert schon
  `pnpm install`. Den Wert in Infisical führen (siehe [env-infisical](../env-infisical/description.md)),
  nie die `.npmrc` mit Klartext-Token committen.
- Peer-Dependencies: `payload ^3.80.0`, optional `@ip-location-db/geo-whois-asn-country >=2` (ab 0.4.1) bzw. `@ip-location-db/dbip-country >=2`. Node ≥ 20.9.
- Nur ESM-Exporte: `@morgendigital/payload-geo`, `/helpers`, `/proxy`, `/client`.

## 2. Einbau in die Payload-Config

```ts
// payload.config.ts → plugins
import { revalidateTag } from 'next/cache'
import { geoToolPlugin } from '@morgendigital/payload-geo'

geoToolPlugin({
  collections: ['pages'],               // nur Collections mit öffentlicher URL und plugin-seo-`meta`
  onSettingsChange: () => revalidateTag('global_geo-settings', 'max'), // Next 15: ohne 2. Argument
  // faqField: 'faq',                   // ab 0.4.0, siehe unten
  // publicUrl: ({ collection, doc, locale, defaultLocale, serverUrl }) => …,
})
```

Alle Optionen (`GeoPluginOptions` in `src/types.ts`):

| Option | Default | Wofür |
| --- | --- | --- |
| `collections` | `['pages']` | Collections, deren Dokumente das Tool lesen und deren `meta.title`/`meta.description` es ändern darf. Andere werden mit `400` abgelehnt. |
| `mediaCollection` / `altField` | `'media'` / `'alt'` | Upload-Collection und Feld für Alt-Texte |
| `publicUrl` | Default-Locale ohne Präfix, sonst `/<locale>`, Slug `home` = Startseite | Öffentliche URL pro Dokument. **Setzen**, sobald die Seite Präfix-Routen hat (`/posts/<slug>`, `/zimmer/<slug>`) — sonst prüft das Tool Meta-Texte gegen falsche URLs. |
| `settingsUpdateAccess` | angemeldete Benutzer | Wer `geo-settings` im Admin ändern darf |
| `onSettingsChange` | — | Läuft im `afterChange` des Globals (nicht bei `context.disableRevalidate`) — hier die robots.txt-/JSON-LD-Caches invalidieren |
| `apiKeyEnv` | `'GEO_TOOL_API_KEY'` | Name der Env-Variable mit dem Schlüssel |
| `adminGroup` | `'Einstellungen'` | Admin-Gruppe für Global und Protokoll |
| `faqField` | — (**ab 0.4.0**) | Name eines Array-Felds `{ question, answer }` auf den `collections`. Ohne Angabe ist `doc.faq` abgeschaltet. Das Feld legt **die Kundenseite** an, nicht das Plugin. |

Was das Plugin in die Config schreibt:

- **Global `geo-settings`** („KI & SEO (GEO-Tool)"): `business` (schema.org-Typ, Koordinaten,
  `sameAs`-Profile, Check-in/-out, Haustiere) und `ai` (`search`, `aiInput`, `aiTrain`,
  `blockTrainingBots`; Default Suche + KI-Antworten ja, Training nein). **Öffentlich lesbar**
  (`read: () => true`) — es steht nichts drin, was nicht ohnehin in robots.txt/JSON-LD landet.
- **Collection `geo-changes`** („GEO-Tool-Änderungen"): Protokoll jeder eingespielten Änderung mit
  Vorher-/Nachher-Wert, Modus und Status. Nur lesbar, nur für angemeldete Benutzer.
- **Collection `geo-stats`** (versteckt): Tagessummen. Nur lesbar.
- **Endpunkte** `/api/geo/*` (§3) und ein `onInit`, das die Zählungen jede Minute in die DB schreibt.

Danach `pnpm generate:types`, `pnpm generate:importmap` und die Migration (§6).

### robots.txt aus den Einstellungen

```ts
// app/(frontend)/robots.txt/route.ts
import { unstable_cache } from 'next/cache'
import { getPayload } from 'payload'
import config from '@payload-config'
import { buildRobotsTxt } from '@morgendigital/payload-geo/helpers'

export const dynamic = 'force-static'

const getSettings = unstable_cache(
  async () => (await getPayload({ config })).findGlobal({ slug: 'geo-settings', depth: 0 }),
  ['geo-settings'],
  { tags: ['global_geo-settings'] },
)

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SERVER_URL
  const body = buildRobotsTxt(await getSettings(), {
    sitemaps: [`${url}/pages-sitemap.xml`, `${url}/posts-sitemap.xml`],
    // disallow: Default ['/admin/', '/api/']
  })
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
```

`buildRobotsTxt` schreibt `User-agent: *`, die `Content-Signal`-Zeile, `Allow: /`, die
`disallow`-Pfade und — nur wenn `blockTrainingBots` an ist — ein `Disallow: /` für `TRAINING_BOTS`
(`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `Meta-ExternalAgent`, `CCBot`,
`Bytespider`). Retrieval-Bots bleiben immer erlaubt.

Pflicht dazu, sonst gewinnt die alte Datei:

- in `next-sitemap.config.cjs` **`generateRobotsTxt: false`**
- **`public/robots.txt` löschen** — auch lokal, `next-sitemap` legt sie bei jedem `postbuild` neu an
  (Befund karlingerhof, [geo §1](../geo/description.md#befunde-aus-karlingerhof-oktober-2026))
- Dev-Domains bleiben `noindex` — siehe [geo §1, Befunde frechinger](../geo/description.md#befunde-aus-frechinger-september-2026);
  dort vor `buildRobotsTxt` verzweigen.

### Strukturierte Daten ergänzen

```ts
import { applyBusinessSettings } from '@morgendigital/payload-geo/helpers'

const business = applyBusinessSettings(baseEntity, geoSettings, [footer.instagram, footer.facebook])
```

`applyBusinessSettings` erweitert das bestehende Betriebs-Objekt des `@graph` (aus `seo-defaults`,
siehe [geo §5](../geo/description.md#5-strukturierte-daten-als-graph)) — es baut **keinen** eigenen
Graphen. Es setzt `@type` (wenn gewählt), `geo` (nur wenn beide Koordinaten Zahlen sind),
`checkinTime`/`checkoutTime`, `petsAllowed` (nur bei Ja/Nein) und führt `sameAs` aus dem dritten
Argument und den Einstellungen zusammen — dedupliziert und nur URLs mit Profilpfad (`isProfileUrl`:
`https://www.instagram.com/` ohne Pfad fliegt raus).

## 3. Schlüssel, Endpunkte und der gemischte Modus

```bash
openssl rand -hex 32   # → GEO_TOOL_API_KEY in Dokploy (Runtime-Env), Wert in Infisical
```

- Alle Endpunkte außer dem Beacon verlangen den Header **`x-geo-tool-key`** (Vergleich mit
  `timingSafeEqual`).
- **Ohne Variable oder mit weniger als 32 Zeichen ist die Schnittstelle aus** — jeder Aufruf
  antwortet `503 GEO-Tool-Schnittstelle ist deaktiviert`. Falscher Schlüssel: `401`.
  Das Paket zu installieren öffnet also nichts, solange der Schlüssel fehlt.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/geo/manifest` | Version, `features`, Sprachen, Collections, Operationen und ihr Modus, erlaubte Einstellungs-Pfade |
| GET | `/api/geo/documents?collection=pages&locale=de` | veröffentlichte Dokumente mit URL und Meta (max. 1000) |
| GET | `/api/geo/media?locale=de&missingAlt=true` | Bilder, optional nur ohne Alt-Text (max. 2000) |
| GET | `/api/geo/settings` | aktueller Stand von `geo-settings` |
| POST | `/api/geo/changes` | 1–200 Änderungen pro Aufruf, Ergebnis pro Eintrag |
| POST | `/api/geo/changes/:id/revert` | Änderung zurücknehmen |
| POST | `/api/geo/collect` | intern, nur für `geoTrack` mit `transport: 'http'` |
| GET | `/api/geo/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | Tagessummen (Default: letzte 30 Tage) |
| POST | `/api/geo/beacon` | **öffentlich**, ab 0.4.0, siehe §5 |

**Gemischter Modus, serverseitig erzwungen** — der Modus folgt aus der Operation, das Tool kann ihn
nicht wählen:

| Operation | Modus | Grenzen |
| --- | --- | --- |
| `media.alt` | **live** | nicht leer, max. 250 Zeichen |
| `settings.set` | **live** | nur Pfade aus `SETTINGS_PATHS` (`business.*`, `ai.*`) |
| `doc.meta` | **Entwurf** (`draft: true`) | nur `title`/`description`, nur `collections`; übrige Meta-Felder bleiben erhalten |
| `doc.faq` (ab 0.4.0) | **Entwurf** | nur mit `faqField`, 1–40 Einträge, Frage ≤ 300 / Antwort ≤ 4000 Zeichen |

Veröffentlicht wird im CMS der Kundenseite, nicht vom Tool. Jede Änderung landet in `geo-changes`.
Rückgängig setzt den Vorher-Wert — **außer** bei einem vorher leeren Alt-Text: Das gibt `409`, weil
`alt` Pflichtfeld ist; dann einen korrigierten Alt-Text einspielen.

### Die Gegenseite im GEO-Tool

- **Projekt → Einstellungen → „Website-Anbindung"** (`/app/<projectId>/project`): CMS auf
  „Payload (Write-Back möglich)", **API-Adresse** nur setzen, wenn die API nicht unter
  `<Domain>/api` liegt (z. B. lokaler Test), **API-Schlüssel** = Wert von `GEO_TOOL_API_KEY`.
  Den Schlüssel dürfen nur Super-Admins setzen; er wird verschlüsselt gespeichert, nie wieder
  angezeigt, leer lassen behält den bisherigen.
- **Lesen:** `manifest`, `documents`, `media` (für Vorschläge), `settings` (für `sameAs`-Vorschläge
  aus geprüften Profilen), `stats` — der Job `syncSiteStats` holt täglich um 02:30 die letzten
  3 Tage (beim ersten Mal 90) und ersetzt sie im Tool. Ohne `stats` im Manifest (Paket < 0.2.0)
  bricht der Abgleich mit Hinweis ab.
- **Schreiben:** unter **„Änderungen"** (`/app/<projectId>/changes`) erzeugt „Verbesserungen vorschlagen"
  Alt-Texte (nur fehlende, per Bilderkennung) und Meta-Texte (Description fehlt oder < 70 / > 160
  Zeichen, Titel > 60). Erst **„Freigegeben"** spielt die Änderung per `POST /api/geo/changes` ein;
  „Rückgängig" ruft `/revert`.

## 4. Besuche, Bot-Abrufe und Anfragen aus KI

```ts
// src/proxy.ts (Next 16) bzw. middleware.ts — vor dem eigenen Code
import { geoTrack } from '@morgendigital/payload-geo/proxy'

export function proxy(request: NextRequest, event: NextFetchEvent) {
  geoTrack(request, event)
  // …
}
```

- Zählt nur Aufrufe mit KI-Referrer/`utm_source` (`chatgpt`, `perplexity`, `gemini`, `claude`,
  `copilot`, `other-ai`) und KI-Bots (`AI_BOTS`). Alles andere kostet nichts.
- Standard ist `transport: 'memory'`: Proxy und Payload teilen sich eine Warteschlange im Prozess,
  das Plugin schreibt sie minütlich in die DB. Bei einem Neustart gehen höchstens 60 s verloren.
  Setzt einen **dauerhaft laufenden Node-Prozess** voraus (Dokploy: ja).
- `transport: 'http'` nur, wenn der Proxy getrennt läuft (Edge). Er liest dann
  `process.env.GEO_TOOL_API_KEY` — wer `apiKeyEnv` umbenennt, muss `apiKey` mitgeben.
  Hintergrund 0.2.1: Der HTTP-Aufruf auf die eigene Domain kam hinter Traefik/Cloudflare aus dem
  Container nicht an.
- Der `matcher` des Proxys bestimmt, was gezählt werden kann — ausgeschlossene Pfade fehlen.

**Land des Besuchers** (ab 0.3.0, nie bei Bots): aus `cf-ipcountry`, `x-vercel-ip-country`,
`cloudfront-viewer-country`, `x-country-code` oder `x-geoip-country`; ohne Header optional aus
`@ip-location-db/geo-whois-asn-country` (ab 0.4.1, ≈ 49 MB im Image, CC0, nur Node-Runtime). Ohne beides bleibt
das Land leer. Das frühere `@ip-location-db/dbip-country` ist auf npm **deprecated**; 0.4.1 liest es weiter, wenn es
installiert ist, die neue Datenbank hat aber Vorrang. Beim Umstieg das alte Paket entfernen und bei Standalone-Builds
`outputFileTracingIncludes` auf `node_modules/@ip-location-db/geo-whois-asn-country/*-num.csv` umstellen.

**Anfragen zuordnen** braucht Speicherung im Browser und damit Einwilligung:

```ts
// Client — bei jedem Seitenaufruf mit dem aktuellen Consent-Status
import { captureAiSource, getAiSource, clearAiSource } from '@morgendigital/payload-geo/client'

captureAiSource({ consent: hasStatisticsConsent })   // ohne Consent: speichert nichts
// beim Absenden: verstecktes Feld aiSource = getAiSource() ?? ''
// beim Widerruf: clearAiSource()
```

```ts
// Collection mit Einsendungen
import { geoInquiryHook } from '@morgendigital/payload-geo'

hooks: {
  afterChange: [
    geoInquiryHook({
      getSource: (doc) => doc.aiSource,
      getPath: (doc) => doc.page,
      shouldCount: (doc) => doc.guardStatus !== 'altcha-failed', // Spam nicht mitzählen
    }),
  ],
}
```

Das Feld `aiSource` legt die Kundenseite selbst in der Einsendungs-Collection an (Schema-Änderung
der Kundenseite). Ohne Einwilligung zählt die Anfrage als `unknown` — „Anfragen aus KI" ist immer
eine Untergrenze. Das dem Kunden vorab sagen, zusammen mit der Referrer-Lücke aus
[geo §8](../geo/description.md#8-messung--und-warum-die-zahlen-nie-stimmen).

## 5. Klicks zur Buchung (ab 0.4.0)

```tsx
'use client'
import { useEffect } from 'react'
import { trackBookingClicks } from '@morgendigital/payload-geo/client'

export function BookingClickTracking() {
  useEffect(() => trackBookingClicks({ domains: ['buchung.hotel.at'], bookingPages: ['/buchen', '/en/book'] }), [])
  return null
}
```

- Erkennt Links auf bekannte Buchungsmaschinen (`BOOKING_ENGINES`), auf `domains` (optional mit Pfad)
  und Elemente mit `data-geo-booking` — auch Mittelklick und Formulare, deren `action` zur
  Buchungsmaschine führt. Öffnet ein Button die Buchung per JavaScript: `trackBookingClick()`.
- `bookingPages`: Links auf eigene Buchungsseiten bekommen bei KI-Besuchen `?geo_src=<KI>` angehängt —
  die Herkunft bleibt ohne Speicherung und ohne Einwilligung bis zum Klick erhalten.
- Versand per `sendBeacon` an **`POST /api/geo/beacon`** — der einzige Endpunkt ohne Schlüssel und
  deshalb eng begrenzt: nur `booking-click`, nur von der eigenen Seite (Origin/Referer =
  `serverURL` oder Host der Anfrage, `www.` egal, sonst `403`), Quelle nur aus `AI_SOURCES` oder
  `unknown`, Pfad relativ und ≤ 500 Zeichen, Body ≤ 1000 Zeichen, **höchstens 30 Klicks pro Minute
  und IP** (`429`, Zähler nur im Speicher). Gespeichert wird die Tagessumme, nie die IP.
- `serverURL` in der Payload-Config muss auf die Live-Domain zeigen, sonst hängt die Prüfung am
  `Host`-/`x-forwarded-host`-Header des Reverse Proxys.

## 6. Schema-Änderungen → Migration in der Kundenseite

Kundenseiten laufen in Produktion mit `push: false` (siehe
[database-migrations](../database-migrations/description.md)). Jede Version mit Schema-Änderung
braucht deshalb eine Migration **in der Kundenseite**:

```bash
pnpm add @morgendigital/payload-geo@<version>
pnpm payload migrate:create payload_geo_<version>
# Datei lesen — vor allem bei Enums (Postgres): Enum erweitern, nicht DROP + CREATE
```

| Von → auf | Was die Migration tun muss |
| --- | --- |
| — → 0.2.0 / 0.2.1 / 0.3.0 (Erstinstallation) | Global `geo-settings`, Collections `geo-changes` und `geo-stats` (ab 0.3.0 mit `country`) anlegen |
| 0.2.x → 0.3.0 | Feld `geo-stats.country` |
| 0.3.0 → 0.4.0 | Enum `geo-stats.kind` um `booking-click` erweitern |
| `faqField` aktivieren | kein Plugin-Schema — aber das FAQ-Array-Feld der Kundenseite selbst |
| eigenes `aiSource`-Feld für Anfragen | Feld in der Einsendungs-Collection der Kundenseite |

0.2.0 → 0.2.1 ändert kein Schema. Fehlt die Migration, scheitert in Postgres das Schreiben der
Statistik — und das fällt nur als `[payload-geo] Statistik konnte nicht gespeichert werden` im Log auf;
die Zählung bleibt im Puffer und wird jede Minute erneut versucht.

## 7. Datenschutz

| Was | Einwilligung | Gespeichert |
| --- | --- | --- |
| `geoTrack` (Besuche, Bot-Abrufe) | nein | Tagessumme: Datum, Quelle, Seite, Land — keine IP, keine Cookies |
| Buchungsklick mit Herkunft der aktuellen Seite bzw. `geo_src` | nein | Tagessumme wie oben |
| `captureAiSource` (sessionStorage, Herkunft über mehrere Seiten) | **ja** — Kategorie Statistik/Messung im Cookie-Banner ([tracking](../tracking/description.md)) | Quelle im `sessionStorage` des Browsers |
| Land aus IP (Länder-Datenbank) | nein | nur das Land; die IP wird nur im Speicher nachgeschlagen |

- `geo-whois-asn-country` ist CC0 — keine Namensnennung nötig. Nur wer noch `@ip-location-db/dbip-country`
  nutzt (CC BY 4.0), muss „IP Geolocation by DB-IP" mit Link auf https://db-ip.com nennen.
- Das Rate-Limit des Beacons hält IPs bis zu einer Minute im Speicher, nie in der DB.
- In der Datenschutzerklärung den Zweck (Messung der Sichtbarkeit in KI-Suchen) und die
  Übermittlung der Tagessummen an das GEO-Tool aufnehmen — Abgleich wie in
  [go-live-check](../go-live-check/description.md).

## 8. Bekannte Fallen

- **`public/robots.txt` verdeckt die Route** — lokal und im Build. Siehe §2 und
  [geo, Befunde karlingerhof](../geo/description.md#befunde-aus-karlingerhof-oktober-2026)
  (dort auch: Content-Signal aus dem CMS statt im Code, `sameAs` aus zwei Quellen zusammenführen).
- **Meta als Entwurf setzt Drafts voraus.** Das Plugin schreibt mit `draft: true`; ob daraus ein
  echter Entwurf wird, hängt an `versions.drafts` der Collection. In jeder Collection aus
  `collections` Drafts aktiv haben und den ersten eingespielten Meta-Text im Admin gegenprüfen.
- **Seite ohne `localization`:** Das Manifest meldet dann `locales: []`. Der Vorschlags-Job des Tools
  läuft über diese Liste — eine einsprachige Seite bekommt keine Alt-/Meta-Vorschläge.
- **`publicUrl` vergessen** bei Präfix-Routen: Das Tool erzeugt Meta-Vorschläge gegen URLs, die es
  nicht gibt.
- **Schlüssel unter 32 Zeichen** schaltet die Schnittstelle ab (`503`), obwohl das Tool Schlüssel ab
  16 Zeichen annimmt. Immer `openssl rand -hex 32` (64 Zeichen).
- **`NODE_AUTH_TOKEN` fehlt beim Build** → `pnpm install` scheitert mit 401/404 aus
  `npm.pkg.github.com`, nicht erst zur Laufzeit.

## Checkliste: neue Kundenseite anbinden

1. `.npmrc` mit `@morgendigital`-Registry, `NODE_AUTH_TOKEN` (classic, `read:packages`) lokal und in
   Dokploy als Build-Env, Wert in Infisical
2. `pnpm add @morgendigital/payload-geo` (neueste **veröffentlichte** Version, §0), optional
   `@ip-location-db/geo-whois-asn-country`
3. `geoToolPlugin({ collections, onSettingsChange, publicUrl? })`, Drafts in allen `collections`
4. `pnpm generate:types`, `pnpm generate:importmap`, `pnpm payload migrate:create`, Migration lesen
5. robots.txt-Route mit `buildRobotsTxt`, `generateRobotsTxt: false`, `public/robots.txt` löschen
6. `applyBusinessSettings` ins Betriebs-JSON-LD; Einstellungen im Admin mit dem Kunden ausfüllen
   (Content-Signal ist eine Kundenentscheidung, [geo §2](../geo/description.md#2-content-signals-policy--die-entscheidung-die-der-kunde-treffen-muss))
7. `geoTrack` in `proxy.ts`; bei Formularen `captureAiSource` (nur mit Consent) + `aiSource`-Feld +
   `geoInquiryHook`; ab 0.4.0 `trackBookingClicks`
8. `GEO_TOOL_API_KEY` (`openssl rand -hex 32`) in Dokploy und Infisical, deployen
9. Prüfen: `curl -s https://<domain>/api/geo/manifest` → `401` (nicht `503`);
   mit `-H "x-geo-tool-key: …"` → JSON mit Sprachen, Collections, `features`
10. Im Tool: Projekt → Website-Anbindung → CMS Payload, Schlüssel hinterlegen (Super-Admin);
    unter „Änderungen" → „Verbesserungen vorschlagen", einen Alt-Text freigeben, in `geo-changes` gegenprüfen,
    einmal Rückgängig testen
11. Datenschutzerklärung ergänzen (§7)

## Checkliste: Plugin aktualisieren

1. CHANGELOG lesen — Schema-Änderung? (§6)
2. `pnpm add @morgendigital/payload-geo@<version>`
3. `pnpm generate:types`, bei Schema-Änderung `pnpm payload migrate:create` und Datei lesen
4. Neue Exporte/Optionen einbauen (z. B. 0.4.0: `trackBookingClicks`, `faqField`)
5. Deploy; Migration läuft am Containerstart ([database-migrations](../database-migrations/description.md))
6. Manifest abrufen: `features` enthält die neuen Funktionen (nicht nur `version` prüfen — 0.3.0
   meldet `0.2.1`)
7. Am nächsten Tag im Tool unter „KI-Traffic" prüfen, dass der nächtliche Abgleich Zahlen geliefert hat

**Neue Version veröffentlichen** (im Repo `geo-tool-ai`): Version in `package.json`,
`PLUGIN_VERSION` in `src/endpoints.ts` und `CHANGELOG.md` anheben, committen,
`git tag payload-geo-v<version> && git push origin payload-geo-v<version>`. Die Action
`publish-payload-geo.yml` prüft Tag = `package.json`-Version und das Token, testet (inkl. Integration
gegen Postgres) und veröffentlicht.
