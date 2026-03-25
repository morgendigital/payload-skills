# Popup-System (Globals + Layout + Newsletter-Dialog)

Übersicht, wie das **Marketing-Popup** und der **Newsletter-Dialog** über Payload **Globals** gesteuert werden, wie sie im **Next.js-Layout** eingebunden sind und wie sie mit **Lenis**, **CMSLink-Aktionen** und dem Block **Popup Section** zusammenspielen. Für Übernahme in andere Payload/Next-Projekte.

---

## 1. Zwei getrennte Bausteine

| Baustein               | Global `slug`     | Rolle                                                                                                                                      |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Marketing-Popup**    | `popup`           | Modales Fenster nach Regeln (aktiv, Seiten, Häufigkeit, LocalStorage); optional mit **Primary Action** (`link()`-Gruppe).                  |
| **Newsletter-Inhalte** | `newsletterTexts` | Texte und Labels für das **Newsletter-Popup** (wird per **CustomEvent** oder Inline im Block geöffnet) und für **`NewsletterSignupForm`**. |

Beide sind **eigene Globals** — keine verschachtelte „Popup“-Collection. Das trennt Marketing-Kampagne von Formular-Copy.

---

## 2. Registrierung in Payload

**Datei:** `src/payload.config.ts`

```ts
globals: [Header, Footer, ContactInfo, TopBar, Popup, NewsletterTexts].map((global) =>
  applyDefaultLocaleRequiredToGlobal(global),
),
```

- **`Popup`**: `src/Popup/config.ts` → `GlobalConfig` mit `slug: 'popup'`.
- **`NewsletterTexts`**: `src/NewsletterTexts/config.ts` → `slug: 'newsletterTexts'`.

Damit erscheinen sie im Admin unter Globals und landen in **`payload-types.ts`** (`Config['globals']`). Ohne Eintrag hier kennt **`getGlobal` / `getGlobalNoCache`** den Slug nicht (TypeScript und Laufzeit).

---

## 3. Global `popup` — Aufbau

**Datei:** `src/Popup/config.ts`

### Zugriff

- **`read: () => true`** — Frontend darf die Global lesen (für SSR im Layout).
- **`update: adminOrContentManager`** — nur berechtigte Rollen ändern (Projekt-spezifisch).

### Felder (überblick)

| Feld                   | Typ                                                                                          | Zweck                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `active`               | checkbox                                                                                     | Master-Schalter; wenn `false`, rendert `PopupClient` nichts.                                        |
| `display`              | group                                                                                        | Steuerung **wo** das Popup erscheint.                                                               |
| `display.mode`         | select                                                                                       | `all` oder `includeOnly` (nur ausgewählte Pages).                                                   |
| `display.includePages` | relationship → `pages`, hasMany                                                              | Nur wenn `includeOnly`.                                                                             |
| `display.excludePages` | relationship → `pages`, hasMany                                                              | **Ausschluss** hat Vorrang vor Include.                                                             |
| `frequency`            | select                                                                                       | `once` (localStorage), `always` (pro Session), `everyNDays` + `repeatDays`.                         |
| `headline`             | richText (lokalisiert)                                                                       | Lexical mit Markenfarben.                                                                           |
| `subline`              | text (lokalisiert)                                                                           |                                                                                                     |
| `primaryAction`        | **`link({ appearances: false, localized: true, overrides: { name: 'primaryAction', … } })`** | Gleiches Link-Modell wie überall; im UI wird dennoch **`appearance="cta"`** gesetzt (siehe Client). |
| `closeButtonLabel`     | text (lokalisiert)                                                                           |                                                                                                     |

### Hooks

- **`beforeChange: [requireValidLocaleOnGlobalWrite]`** — Lokale Pflichtfelder pro Locale (Projekt-Hook).
- **`afterChange: [revalidatePopup]`** — **`src/Popup/hooks/revalidatePopup.ts`**:  
  für jede Locale `revalidateTag('global_popup_${locale}')` und `revalidatePath(localizePath('/', locale), 'layout')`, damit Layout-SSR neue Inhalte zieht (sofern ihr Tags beim Cachen nutzt).

---

## 4. Global `newsletterTexts` — Aufbau

**Datei:** `src/NewsletterTexts/config.ts`

Reine **Content-/Form-Labels** Global (lokalisiert): `headline` (richText), `subline`, Platzhalter/Aria fürs E-Mail-Feld, DSGVO-Text-Schnipsel, `submitLabel`, `closeButtonLabel`, `fallbackError`, `success`.

### Hooks

- **`afterChange: [revalidateNewsletterTexts]`** — analog: Tags `global_newsletterTexts_${locale}` + Layout-Revalidate (`src/NewsletterTexts/hooks/revalidateNewsletterTexts.ts`).

Diese Daten werden **nicht** „aktivieren“ das Newsletter-Popup — sie versorgen nur **`NewsletterPopupClient`** und **`NewsletterSignupForm`**.

---

## 5. Daten im Frontend laden

**Datei:** `src/utilities/getGlobals.ts`

- **`getGlobalNoCache('popup', depth, locale)`** / **`getGlobalNoCache('newsletterTexts', …)`**  
  Nutzt `unstable_noStore()` → **kein** Full-Route-Cache für diese Aufrufe; Layout bekommt bei jedem Request frische Globals (sinnvoll für redaktionell häufig geänderte Texte).

- **`getCachedGlobal`** (z. B. in `RenderBlocks` für `newsletterTexts`) — **`unstable_cache`** mit Tag `global_${slug}_${locale}`; passt zu den Revalidate-Hooks der Globals.

**Layout verwendet bewusst `getGlobalNoCache`** für Popup-Daten, damit keine 60s-Verzögerung aus dem globalen Cache entsteht (`GLOBAL_CACHE_REVALIDATE_SECONDS`).

---

## 6. Einbindung ins Layout

**Datei:** `src/app/(frontend)/[locale]/layout.tsx`

Ablauf:

1. `locale` aus Params validieren (`isLocale`).
2. Parallel laden:
   - `getGlobalNoCache('popup', 1, typedLocale)`
   - `getGlobalNoCache('topBar', …)` (nur indirekt relevant)
   - `getGlobalNoCache('newsletterTexts', 1, typedLocale)`
3. Render-Reihenfolge:
   - `Header`
   - Abstandshalter (`--header-offset`)
   - `<main>{children}</main>`
   - `Footer`
   - **`<PopupClient data={popupData} />`**
   - **`<NewsletterPopupClient data={newsletterTextsData} />`**

Beide Client-Komponenten sitzen **außerhalb** von `main`, **nach** Footer — typisch für Portale/Overlays über der ganzen Seite.

**Wichtig:** Nur Layouts einbinden, die **wirklich** auf allen öffentlichen Seiten laufen; sonst Popups doppelt oder gar nicht.

---

## 7. `PopupClient` — Verhalten (Marketing-Popup)

**Datei:** `src/Popup/Component.client.tsx`

- **Radix Dialog** (`@radix-ui/react-dialog`).
- **`usePathname`**: aktuelle URL → **logischer Page-Slug** (`getCurrentPageSlugFromPathname`): erste Pfad-Segment wird bei `de`/`en`/`it` als Locale entfernt, Rest = Slug; leer → **`home`** (muss zu euren Page-Slugs passieren).
- **`canShowOnThisPage`**:
  - Exclude-Liste (Slugs aus `display.excludePages`)
  - bei `includeOnly`: nur wenn aktueller Slug in Include-Liste.
- **`frequency`**:
  - **`once`**: `localStorage` Key `lamedica:popup:${id}:dismissed`
  - **`always`**: `sessionStorage` `…:sessionSeen`
  - **`everyNDays`**: `localStorage` `…:lastSeen` + `repeatDays`
- Beim Schließen / Klick auf Primary Action: **`persistSeen`** schreibt die Speicher-Flags; Primary Action sitzt in einem Wrapper mit **`onClickCapture`** → Popup schließen + persistieren vor Navigation.
- **`data-popup-open`** auf `<html>` + **Lenis stop/start** (gleiches Muster wie Newsletter-Popup), abgestimmt mit Mobile-Menü-Attribut `data-mobile-menu-open`.

Ohne **`data.headline`** oder **`!active`** oder Seitenfilter: **`return null`**.

---

## 8. `NewsletterPopupClient` — Verhalten

**Datei:** `src/Popup/NewsletterPopup.client.tsx`

- Ebenfalls Radix **Dialog**.
- **Öffnen nur** durch:
  - **`window.dispatchEvent`** auf **`NEWSLETTER_POPUP_OPEN_EVENT`** (`src/Popup/newsletterPopupEvents.ts`), z. B. von **`CMSLink`** bei `type: 'action'` / `openNewsletterPopup`, oder
  - indirekt nur über State (kein Auto-Open beim Seitenload).
- Lenis + `data-popup-open` wie oben.
- Inhalt: **RichText** + **`NewsletterSignupForm`** mit `showCloseButton`.
- Ohne `headline` im Global: **`return null`** (kein leerer Dialog im Baum).

---

## 9. Verknüpfung mit dem Link-System

- In **`link()`** mit **`enableActions: true`** gibt es die Aktion **`openNewsletterPopup`**.
- **`CMSLink`** feuert das Event → **`NewsletterPopupClient`** öffnet — unabhängig vom Marketing-`popup` Global.

Siehe **`docs/cms-link-system.md`**, Abschnitt zu Aktionen.

---

## 10. Block „Popup Section“ (Inline-Newsletter auf der Page)

**Config:** `src/blocks/PopupSection/config.ts` — fast nur **`sectionNavigationFields`** (Nav/Anker).

**Rendering:** `src/blocks/RenderBlocks.tsx` lädt **`getCachedGlobal('newsletterTexts', 1, locale)`** und übergibt **`newsletterTextsData`** nur an **`popupSection`**.

**Component:** `src/blocks/PopupSection/Component.tsx` zeigt **`NewsletterSignupForm`** mit diesen Texten — **kein** separates Dialog-Root; das ist die eingebettete Variante.

---

## 11. Abhängigkeiten zum Portieren

| Abhängigkeit                                             | Zweck                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@radix-ui/react-dialog`                                 | Modal                                                                    |
| `next/navigation` `usePathname`                          | Seiten-Slug für `PopupClient`                                            |
| Lenis `getLenisInstance`                                 | Scroll-Lock (optional vereinfachen)                                      |
| `CMSLink`, `RichText`, UI-`Button`, `AnimatedCTAContent` | Wie im Lamedica-Frontend                                                 |
| `link()` Factory                                         | `primaryAction` im Popup-Global                                          |
| `getGlobalNoCache` / Globals in `payload.config`         | Datenpipeline                                                            |
| **`LOCALES`**, **`localizePath`**                        | Revalidate in Hooks                                                      |
| Konsistenz Slug-Logik                                    | `home` vs. URL-Pfade muss zu **`getCurrentPageSlugFromPathname`** passen |

---

## 12. Neues Projekt: sinnvolle Reihenfolge

1. Globals `popup` und `newsletterTexts` (Felder vereinfachen oder 1:1 übernehmen) in **`buildConfig.globals`**.
2. **`getGlobal`** / **`getGlobalNoCache`** mit euren Slugs und `locale`.
3. **Server Layout**: Daten fetchen, **Client**-Komponenten unterhalb von `main`.
4. **`PopupClient`**: Locale-Stripping und Slug-Vergleich an euer Routing anpassen (oder Relationships durch Slug-Strings ersetzen).
5. **Revalidate-Hooks** an eure Cache-Tags koppeln.
6. Optional: **`enableActions`** + Event + **`NewsletterPopupClient`**.
7. Optional: Block **Popup Section** + `RenderBlocks`-Pattern für `newsletterTexts`.

Damit ist das Popup-System **als Kombination aus zwei Globals, Layout-Mount und zwei Client-Dialogen** in einem neuen Payload+Next-Projekt nachvollziehbar umsetzbar.
