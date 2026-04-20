# Tracking und Cookie-Banner (c15t 2.x)

Diese Datei beschreibt, wie in Payload/Next-Projekten **GTM**, allgemeines Tracking und der Cookie-Banner mit **`@c15t/nextjs` ^2.x** umgesetzt werden sollen. **Pfade und Dateinamen** sind bewusst als **Richtlinie** formuliert — bitte an die **tatsächliche Projektstruktur** anpassen (nicht alles muss in einer einzigen Provider-Datei liegen).

## Agenten: Quellen-Reihenfolge

- Zuerst die **installierte Paket-Doku** lesen: `node_modules/@c15t/nextjs/docs/README.md` sowie dort verlinkte Seiten (z. B. `script-loader.md`).
- Ergänzend: [c15t — AI Agents](https://c15t.com/docs/ai-agents) und die Website-Doku — bei Abweichungen gewinnt die **installierte Version** im Repo.

## Überblick

- **`@c15t/nextjs` ^2.x** ist der Consent-Manager; UI-Komponenten heißen **`ConsentBanner`** und **`ConsentDialog`** (nicht mehr `CookieBanner` / `ConsentManagerDialog` aus 1.x).
- Externe Tracking-Skripte werden über **`ConsentManagerProvider`** mit **`options.scripts`** registriert — oder nachträglich per **`useConsentManager().setScripts(...)`** (siehe installiertes **`script-loader.md`**).
- Es gibt **keinen** stabilen Export **`@c15t/nextjs/client`** / **`ClientSideOptionsProvider`** in **2.0.0** (kein `./client`-Pfad). Nicht nach veralteten Snippets aus 1.x-Projekten suchen.
- Eigene Tracking-Events laufen zentral über **`pushTrackingEvent(...)`**.
- Events werden nur gesendet, wenn **Marketing-Consent** vorliegt (siehe Abschnitt [Marketing-Consent (2.x)](#marketing-consent-2x)).

## Empfohlene Dateistruktur (nicht nur eine Provider-Datei)

Statt alles in `src/providers/index.tsx` zu stapeln:

| Rolle | Typischer Pfad / Modul |
| ----- | ---------------------- |
| App-Shell | **`src/providers/index.tsx`**: nur den Wrapper einbinden (z. B. `ConsentAndTrackingProvider`). |
| Client-Bundle Consent + UI | **`src/components/Consent/ConsentAndTrackingProvider.client.tsx`** (oder gleichwertig): `ConsentManagerProvider`, `ConsentBanner`, `ConsentDialog`, Bridges zu Tracking, optional `TrackingClickListeners`. |
| Consent-Optionen / Scripts bauen | **`src/lib/tracking/buildConsentOptions.ts`** (oder `buildConsentTrackingScripts()` — Namen projektintern vereinheitlichen). |
| Event-Namen | **`src/lib/tracking/events.ts`**. |
| Push-Pipeline | **`src/lib/tracking/push.ts`**. |
| Store ↔ Tracking (Marketing-Flag) | **`src/lib/tracking/consentBridge.ts`**: z. B. `setMarketingConsentFromStore`, `getMarketingConsent()`. |
| Öffentliche IDs zur Build-Zeit | **`src/lib/tracking/publicTracking.build.ts`** (generiert) + Skript **`scripts/generate-public-tracking.mjs`**. |

Wichtig für Skills und Reviews: **„Pfade an die tatsächliche Projektstruktur anpassen“** — die **Trennung** (Provider-Hülle vs. Client-Consent vs. `lib/tracking`) ist das Ziel, nicht ein einzelner Monster-Import.

## Cookie-Banner und Consent Manager (2.x)

Konfiguration erfolgt über **`ConsentManagerProvider`** (u. a. `mode`, Kategorien, Texte, Theming). **`ConsentBanner`** und **`ConsentDialog`** werden als Kinder oder über die vom Paket vorgesehene API eingebunden — Details in der **installierten** README.

Hinweise zu älteren Doku-Beispielen:

- **`ignoreGeoLocation`** aus 1.x-Setups existiert in 2.x **nicht 1:1**; Verhalten und Optionen im **`node_modules/@c15t/nextjs/docs/README.md`** nachschlagen.
- Kategorien (z. B. `necessary`, `marketing`, `measurement`, …) weiterhin projektkonform mit **`buildConsentOptions`** / Provider-Config abstimmen.

## Wo der Cookie-Dialog geöffnet wird

Typisch im Footer:

- z. B. `src/Footer/FooterClient.tsx` und ein Button (z. B. `src/components/CookieBanner/CookieButton.tsx` — **Dateiname** kann abweichen).

Mit **`useConsentManager()`** von **`@c15t/nextjs`** den Dialog öffnen, z. B.:

```ts
consentManager.setIsPrivacyDialogOpen(true);
```

(API-Namen bei Minor-Upgrades prüfen — Quelle: installierte Paket-Doku.) Optional bleibt ein DOM-Fallback (Customize-Button des Banners), falls die API in einem Edge-Case nicht greift.

## GTM, GA4 und Meta Pixel — Skripte

Skripte **nicht** lose im Root-Layout duplizieren, sondern an **c15t** anbinden:

- vorrangig **`ConsentManagerProvider`** → **`options.scripts`**, oder
- **`useConsentManager().setScripts(...)`** nach der Doku in **`script-loader.md`**.

Verwendete Umgebungsvariablen (üblich):

- `NEXT_PUBLIC_GTM_ID`
- `NEXT_PUBLIC_META_PIXEL_ID`
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID`

Konkrete Helper (`googleTagManager`, `metaPixel`, `gtag`, …) und Kategorie-Zuordnung stehen in der **Paket-Doku** der installierten 2.x-Version.

### Wichtig: `next.config.js` → `env` reicht hier oft nicht

Allein **`env`** in `next.config.js` **ersetzt** das unten beschriebene Build-Muster **nicht**, wenn `NEXT_PUBLIC_*` zur **Compile-Phase** nicht zuverlässig im Client-Bundle landen sollen. Teams sollen nicht nur an `env` festhalten und wundern, warum im Browser IDs fehlen.

## Production-Build ohne Mongo + zuverlässige `NEXT_PUBLIC_*` (Tracking-IDs)

Viele Payload/Next-Templates nutzen einen **zweiphasigen** Build:

```text
next build --experimental-build-mode generate-env && next build --experimental-build-mode compile
```

Damit muss in der **Compile-Phase** oft **keine MongoDB** erreichbar sein.

**Problem:** In dieser Pipeline können **`NEXT_PUBLIC_GTM_ID`**, **GA4**, **Meta** im Client-Bundle **nicht** zuverlässig aus **`process.env`** „eingefroren“ werden. Symptom: im Browser fehlen Werte (z. B. leere oder fehlende Nutzung von öffentlichen IDs) → **GTM/Tags greifen nicht**, Tag Assistant zeigt u. U. nichts Nützliches bei **rein dynamisch** injizierten Skripten.

### Empfohlenes Muster

1. **Skript** `scripts/generate-public-tracking.mjs`, das **vor** der **`compile`-Phase** läuft und aus **CI-/Vercel-Env** (optional lokal **`dotenv`** für `.env`) eine Datei **`src/lib/tracking/publicTracking.build.ts`** schreibt, die IDs als **String-Literale** enthält (kein reines `process.env.NEXT_PUBLIC_*` im Client-Pfad, das in `compile` leer bleibt).
2. **`package.json`** (Build), z. B.:

   ```text
   … generate-env && pnpm run generate:public-tracking && … compile
   ```

   Lokal **`dev`**: `generate:public-tracking` vor **`next dev`**, damit Dev und Prod ähnlich starten.
3. **`buildConsentTrackingScripts()`** (oder gleichwertig): beim Auflösen der IDs **zuerst** die exportierten Konstanten aus **`publicTracking.build.ts`**, sonst Fallback auf **`process.env`** für reine Dev-Sessions ohne Generator-Lauf.

So sind **GTM/GA4/Meta**-IDs für den **Browser-Build** vorhersehbar gesetzt, unabhängig davon, ob `compile` Env anders sieht als `generate-env`.

## Marketing-Consent (2.x)

Die alte 1.x-Doku mit **`window.c15tStore`**, **`window.c15t.hasConsent('marketing')`**, diversen **`window.c15t.*`-Pfaden** und aggressivem `localStorage`-Scan ist für **2.x nicht zuverlässig** und soll **nicht** mehr als Primärquelle dienen.

**Variante (nur 2.x):**

- Aus **`useConsentManager().consents.marketing`** (bzw. der in der installierten Version dokumentierten Struktur) den Marketing-Status lesen.
- Im Modul **`consentBridge.ts`** (oder gleichwertig) **`setMarketingConsentFromStore`** und **`getMarketingConsent()`** kapseln; `pushTrackingEvent` nutzt ausschließlich **`getMarketingConsent()`** (kein direktes `window.c15t*` im Push-Pfad).
- Optional nach Zustimmung **`updateScripts()`** (oder die in 2.x dokumentierte Methode) aufrufen, damit registrierte Skripte nachziehen.

## `pushTrackingEvent` — Ziele projektspezifisch

Die Pipeline in **`push.ts`** soll **projektspezifisch** konfigurierbar sein:

- **Immer** sinnvoll: **`dataLayer.push(...)`** für GTM.
- **Meta:** **`fbq`** wenn Meta Pixel Teil des Setups ist.
- **`gtag('event', …)`** ist **optional**: Wenn Messung **primär über GTM** läuft, vermeidet das Weglassen von `gtag` **Doppel-Events** oder konkurrierende GA4-Pfade. In der Skills-Doku explizit: **Ziele wählen, nicht blind alle drei aktivieren.**

## Debugging für Tracking

In **`push.ts`** (oder zentraler Debug-Hilfe) einen Debug-Modus vorsehen, z. B. aktiv wenn:

- URL enthält `?tracking_debug=1`
- `localStorage.setItem('tracking_debug', 'true')`
- `NODE_ENV === 'development'`
- `NEXT_PUBLIC_TRACKING_DEBUG === 'true'`

Logs z. B.: Event wegen fehlendem Consent übersprungen; welche **Ziele** (`dataLayer`, optional `gtag`, `fbq`) tatsächlich angesprochen wurden.

## Zentrale Event-Namen

Typisch in **`src/lib/tracking/events.ts`**: Konstanten für **`pageview`** und **`click`**, damit keine String-Duplikate im UI entstehen.

## Pageview-Tracking

Komponente z. B. **`PageViewTracker.tsx`** (Pfad z. B. unter `src/components/MetaPixel/` oder `src/components/Tracking/`): einmaliger Pageview nach Marketing-Consent, Reaktion auf nachträgliche Zustimmung, Deduplizierung z. B. mit **`useRef`**.

## Klick-Tracking

Global z. B. **`TrackingClickListeners.tsx`**: Listener auf `document`, Mapping für `tel:` / `mailto:` / Button-Texte; am Ende nur **`pushTrackingEvent(...)`**.

## SalesViewer und Drittanbieter

Scripts wie **SalesViewer**, die per **`next/script`** geladen werden, sollten **dieselbe Consent-Strategie** wie GTM/Meta nutzen — nicht dauerhaft parallel „always on“, wenn das Marketing-Modell das nicht erlaubt.

## Architektur-Vorteile

- Consent und Skript-Lifecycle über **c15t 2.x** und Provider-API.
- Eine zentrale **`pushTrackingEvent`**-Pipeline; UI getrennt von Versand.
- Build-Zeit-IDs über **Generator + `publicTracking.build.ts`**, damit **zweiphasiger Next-Build** und **Payload** nicht zu leeren `NEXT_PUBLIC_*` im Client führen.

## Kurzfassung

1. **c15t 2.x** mit **`ConsentManagerProvider`**, **`ConsentBanner`**, **`ConsentDialog`**; Skripte über **`options.scripts`** / **`setScripts`**.
2. **`generate:public-tracking`** zwischen **`generate-env`** und **`compile`**; **`dev`** startet den Generator mit.
3. **`pushTrackingEvent`** nur mit **`getMarketingConsent()`** aus der **2.x-Bridge**, nicht mit 1.x-`window`-Hacks.
4. **Ziele** in **`push.ts`** bewusst wählen (**`gtag` optional** bei GTM-first).
5. Footer öffnet den Consent-Dialog erneut.

## Checkliste: Neues Projekt aus Template

- [ ] **`NEXT_PUBLIC_GTM_ID`** / **GA4** / **Meta** in der **Build-Umgebung** (z. B. Vercel) gesetzt.
- [ ] **`pnpm build`** (bzw. npm/yarn) inkl. **`generate:public-tracking`** **zwischen** `generate-env` und `compile`.
- [ ] Nach Deploy: **Netzwerk** auf **`gtm.js`** und **Consent-Flow** prüfen; **Tag Assistant** allein ist bei dynamisch injizierten Tags **unzuverlässig**.
