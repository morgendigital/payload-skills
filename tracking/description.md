# Tracking und Cookie Banner

Diese Datei beschreibt, wie in diesem Projekt `GTM`, allgemeines Tracking und der Cookie-Banner aktuell umgesetzt sind.

## Überblick

Die Consent- und Tracking-Logik ist zentral in `src/providers/index.tsx` und `src/lib/tracking/push.ts` aufgebaut:

- `c15t` ist der Consent-Manager und steuert den Cookie-Banner sowie den Privacy-Dialog.
- Externe Tracking-Skripte werden im `ConsentManagerProvider` registriert.
- Eigene Tracking-Events laufen zentral über `pushTrackingEvent(...)`.
- Tracking-Events werden nur gesendet, wenn Marketing-Consent vorhanden ist.

## Cookie Banner und Consent Manager

Die Basis liegt in `src/providers/index.tsx`.

Dort wird der komplette App-Tree mit `ConsentManagerProvider` umschlossen. Der Provider ist aktuell so konfiguriert:

- `mode: 'offline'`
- `ignoreGeoLocation: true`
- definierte Kategorien:
  - `necessary`
  - `marketing`
  - `measurement`
  - `experience`
  - `functionality`

Zusätzlich werden dort auch die Texte und das UI-Theming für folgende Komponenten gesetzt:

- `CookieBanner`
- `ConsentManagerDialog`

Das bedeutet:

- Der erste Banner wird global über den Provider eingebunden.
- Das Detail-Modal zum nachträglichen Anpassen der Einwilligung ist ebenfalls global vorhanden.
- Styling und Texte liegen zentral an einer Stelle.

## Wo der Cookie-Dialog geöffnet wird

Im Footer gibt es einen eigenen Einstiegspunkt für die Cookie-Einstellungen:

- `src/Footer/FooterClient.tsx`
- `src/components/CookieBanner/CookieButton.tsx`

`CookieButton` nutzt `useConsentManager()` von `@c15t/nextjs` und öffnet den Dialog über:

```ts
consentManager.setIsPrivacyDialogOpen(true);
```

Falls diese API nicht verfügbar ist, gibt es einen Fallback, der den Customize-Button des Banners per DOM-Selektor klickt.

## Einbindung von GTM, GA4 und Meta Pixel

Die externen Tracking-Skripte werden in `src/providers/index.tsx` über `buildScripts()` vorbereitet.

Verwendete Environment-Variablen:

- `NEXT_PUBLIC_GTM_ID`
- `NEXT_PUBLIC_META_PIXEL_ID`
- `NEXT_PUBLIC_GA4_MEASUREMENT_ID`

Wenn die jeweiligen Variablen vorhanden sind, werden folgende Skripte registriert:

- `googleTagManager({ id: gtmId })`
- `metaPixel({ pixelId: metaPixelId })`
- `gtag({ id: ga4Id, category: 'measurement' })`

Wichtig:

- Die Skripte werden nicht manuell im Layout eingebunden.
- Sie werden dem `ConsentManagerProvider` über `options.scripts` übergeben.
- Dadurch ist die Script-Verwaltung an den Consent-Manager gekoppelt.

## Wie das allgemeine Event-Tracking funktioniert

Die zentrale Event-Pipeline liegt in `src/lib/tracking/push.ts`.

Die wichtigste Funktion ist:

```ts
pushTrackingEvent(eventName, eventData?)
```

Diese Funktion übernimmt drei Aufgaben:

1. Prüfen, ob Marketing-Consent vorhanden ist.
2. Das Event an die angebundenen Tracking-Systeme weiterreichen.
3. Optional Debug-Logs ausgeben.

## Consent-Prüfung vor jedem Tracking

Bevor ein Event gesendet wird, wird über `getMarketingConsent()` geprüft, ob Tracking erlaubt ist.

Die Prüfung ist absichtlich robust aufgebaut und liest Consent aus mehreren möglichen Quellen:

- `window.c15tStore.getState()`
- `window.c15t.hasConsent('marketing')`
- `window.c15t.has('marketing')`
- `window.c15t.preferences`
- `localStorage` mit c15t-bezogenen Keys
- Cookie-Fallbacks

Zusätzlich wird ein interner Cache `cachedMarketingConsent` verwendet, der über `initConsentCache()` gepflegt wird. Dabei wird auf Consent-Änderungen reagiert, damit nach einer nachträglichen Zustimmung direkt getrackt werden kann.

## Wohin Events gesendet werden

Wenn Consent vorhanden ist, schreibt `pushTrackingEvent(...)` das Event in mehrere Targets:

### 1. `dataLayer`

Für GTM wird immer in das globale `dataLayer` gepusht:

```ts
w.dataLayer.push({ event: eventName, ...eventData });
```

Damit kann GTM die Custom Events direkt verarbeiten.

### 2. `gtag`

Falls `gtag` vorhanden ist, wird zusätzlich gesendet an:

```ts
w.gtag("event", eventName, eventData ?? {});
```

Das ist relevant für GA4.

### 3. `fbq`

Falls Meta Pixel geladen ist, wird zusätzlich gesendet an:

```ts
fbq("trackCustom", eventName, eventData);
```

Ohne Payload wird entsprechend nur der Event-Name gesendet.

## Debugging für Tracking

In `src/lib/tracking/push.ts` gibt es einen Debug-Modus.

Debug ist aktiv, wenn eine der folgenden Bedingungen erfüllt ist:

- URL enthält `?tracking_debug=1`
- `localStorage.setItem('tracking_debug', 'true')`
- `NODE_ENV === 'development'`
- `NEXT_PUBLIC_TRACKING_DEBUG === 'true'`

Dann werden in der Konsole Informationen geloggt:

- ob ein Event wegen fehlendem Consent übersprungen wurde
- ob `dataLayer`, `gtag` und `fbq` tatsächlich angesprochen wurden

## Zentrale Event-Namen

Die Event-Namen sind zentral definiert in:

- `src/lib/tracking/events.ts`

Aktuell gibt es dort zwei Gruppen:

- `pageview`
- `click`

Beispiele:

- `pageview_home`
- `pageview_jobs`
- `anruf`
- `mail_gesendet`
- `kontaktformular_gesendet`

Der Vorteil davon ist, dass Event-Namen nicht an vielen Stellen im Code hart codiert werden.

## Pageview-Tracking

Für Seitenaufrufe gibt es die Komponente:

- `src/components/MetaPixel/PageViewTracker.tsx`

Sie bekommt einen `eventName` und sendet den Pageview genau einmal, sobald Consent vorhanden ist.

Wichtig an der Umsetzung:

- Wenn beim ersten Render noch kein Consent vorliegt, wird noch nichts gesendet.
- Sobald der User später Marketing erlaubt, reagiert `onConsentChange(...)` und der Pageview kann doch noch gesendet werden.
- Über `useRef` wird verhindert, dass derselbe Pageview mehrfach gepusht wird.

Verwendung aktuell zum Beispiel in:

- `src/app/(frontend)/[locale]/[slug]/page.tsx`
- `src/app/(frontend)/public-relations/page.tsx`

## Klick-Tracking

Das globale Klick-Tracking sitzt in:

- `src/components/MetaPixel/TrackingClickListeners.tsx`

Diese Komponente wird im Frontend-Layout eingebunden:

- `src/app/(frontend)/[locale]/layout.tsx`

Sie registriert einen globalen Click-Listener auf `document` und erkennt aktuell unter anderem:

- Klicks auf `tel:`-Links
- Klicks auf `mailto:`-Links
- Klicks auf bestimmte Buttons anhand ihres Textes

Beispiele für gemappte Button-Texte:

- `Send it`
- `Bewerbung absenden`
- `Jetzt bewerben`

Teilweise werden dabei zusätzliche Daten mitgegeben, zum Beispiel:

- `tel`
- `email`
- `jobTitle`

Die Komponente selbst ruft am Ende immer nur die zentrale Funktion `pushTrackingEvent(...)` auf. Dadurch bleibt die Tracking-Logik von der UI getrennt.

## Aktuelle Besonderheit: SalesViewer

Im Layout `src/app/(frontend)/[locale]/layout.tsx` ist zusätzlich ein `next/script` für SalesViewer eingebunden.

Aktuell wird dieses Script direkt mit `afterInteractive` geladen.

Wichtig dabei:

- Es ist momentan nicht an die zentrale Consent-Logik aus `pushTrackingEvent(...)` gekoppelt.
- Im File gibt es eine auskommentierte Variante, die SalesViewer erst nach Marketing-Consent laden würde.
- Der aktive Stand ist also: SalesViewer lädt derzeit unabhängig von der beschriebenen Event-Tracking-Pipeline.

Falls man hier dieselbe Consent-Strategie wie bei GTM, GA4 und Meta Pixel möchte, sollte SalesViewer ebenfalls an `c15t` gekoppelt werden.

## Architektur-Vorteile der aktuellen Lösung

- Consent-Management ist zentral im Provider gebündelt.
- Event-Versand läuft über genau eine zentrale Funktion.
- UI, Consent-Handling und Event-Dispatch sind sauber getrennt.
- GTM, GA4 und Meta Pixel können parallel über dieselbe Event-Pipeline bedient werden.
- Durch zentrale Event-Konstanten bleibt das Setup wartbar.

## Kurzfassung

So ist das Setup aktuell gedacht:

1. `c15t` zeigt Banner und Consent-Dialog an.
2. GTM, GA4 und Meta Pixel werden über den Consent-Manager registriert.
3. Eigene Events laufen immer über `pushTrackingEvent(...)`.
4. Ohne Marketing-Consent wird nichts an `dataLayer`, `gtag` oder `fbq` gesendet.
5. Der Footer-Button öffnet den Consent-Dialog erneut, damit Nutzer ihre Auswahl ändern können.
