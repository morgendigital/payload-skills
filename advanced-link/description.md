# CMS-Link-System (Payload + Next.js)

Diese Übersicht beschreibt, wie strukturierte Links im CMS definiert werden und wie sie im Frontend als `CMSLink` sowie im Lexical-Rich-Text gerendert werden. Ziel: Übernahme in andere Projekte mit klarer Abhängigkeiten-Liste.

---

## 1. Übersicht: Zwei Wege zu Links

| Quelle                               | Wo konfiguriert                       | Frontend                                                           |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------ |
| **Link-Gruppe** (Blocks, Globals, …) | Payload-Feld `link()` / `linkGroup()` | `CMSLink` mit `{...link}` aus den Types                            |
| **Rich-Text (Lexical)**              | `LinkFeature` im Editor               | `RichText`-Komponente via `LinkJSXConverter` + `internalDocToHref` |

Beide Wege können interne Dokumente (`pages`, `posts`), Custom-URLs und (nur Rich-Text) den eingebauten Internal-Link-Flow des Lexical-Link-Features nutzen. Nur die **Link-Gruppe** unterstützt zusätzlich Anker auf Blöcke, Aktionen (z. B. Popup) und wählbare Button-„Appearances“ aus dem Schema.

---

## 2. Aktionen (`enableActions`) — kein Link, sondern UI-Event

### Zweck

Redakteure können einen Eintrag wählen, der **keine URL** hat, sondern im Frontend eine **Aktion** auslöst (aktuell: Newsletter-Popup öffnen). Das ist im CMS ein eigener Link-Typ `action`, damit Label und Button-Stil (`appearance`) konsistent zu normalen Links bleiben.

### Payload

1. In der `link()`-Factory **`enableActions: true`** setzen (z. B. in Block- oder Global-Configs).
2. Im Admin erscheint bei `type === 'action'` zusätzlich das Feld **`action`** (Select), z. B. `openNewsletterPopup`.

Ohne `enableActions` gibt es diesen Typ nicht — Reuse in anderen Projekten: neue Optionen einfach im Select ergänzen und im Frontend dieselbe `action`-Discipline auswerten.

### Frontend — `CMSLink`

**Datei:** `src/components/Link/index.tsx`

- Wenn `type === 'action'`, wird **kein** `href` berechnet. Statt `next/link` gibt es ein **`button type="button"`** (oder bei `appearance === 'inline'` / `animatedUnderline` ein natives `<button>` ohne Button-Komponente).
- Beim Klick: optional externes `onClick`, dann — wenn nicht `preventDefault` — Auswertung von `action`:
  - **`openNewsletterPopup`** → `window.dispatchEvent(new CustomEvent(NEWSLETTER_POPUP_OPEN_EVENT))`
- Event-Konstante: `src/Popup/newsletterPopupEvents.ts` (z. B. `lamedica:newsletter-popup:open`).

### Subscriber — Popup

**Datei:** `src/Popup/NewsletterPopup.client.tsx`

- `useEffect` registriert `window.addEventListener(NEWSLETTER_POPUP_OPEN_EVENT, …)`.
- Handler setzt lokalen State (`setOpen(true)`), Dialog öffnet sich; Lenis wird über `data-popup-open` pausiert.

**Übernahme:** Eigene Aktionen = neuer Wert im CMS-Select + neuer `if`-Zweig in `CMSLink` (oder kleines Strategy-Objekt), plus Listener dort, wo die UI lebt. Kein Payload-Feature-Link nötig.

---

## 3. Scroll-to & IDs: Block auf **derselben** Seite (`type: 'block'`)

### Idee

Jeder Layout-Block auf einer Page bekommt beim Rendern eine **stabile DOM-`id`**. Ein Link kann `blockAnchor` auf genau diese ID setzen. Die URL wird `#anker-id`. Beim Klick scrollt die Seite weich zum Block (nicht nur der Browser-Sprung).

### Was im Projekt dafür eingebaut ist (Ende-zu-Ende)

Damit der CMS-Link-Typ **`block`** und die Anker-Picker im Admin dieselben IDs nutzen wie das Live-Frontend, hängen mehrere Bausteine zusammen:

1. **Payload: optionale Navigations-/Anker-Felder auf Layout-Blöcken**  
   **`src/fields/sectionNavigation.ts`** definiert `sectionNavigationFields`:
   - **`showInNav`** — „Show in Header Navigation“
   - **`navLabel`** — sichtbar wenn `showInNav`, wird in die Anker-Fallback-Kette einbezogen
   - **`anchorId`** — optional, ebenfalls abhängig von `showInNav`; eigener Slug-Teil für den Anker (wird normalisiert)

   Diese Felder werden in die **Block-Configs** der Page-Layout-Blöcke eingespielt (z. B. `...sectionNavigationFields` in `Content/config.ts`, `CallToAction/config.ts`, `CenteredContent/config.ts`, usw.). Ohne diese Felder auf dem Block fehlen Redakteur-Steuerung und ein Teil der Fallback-Daten — die ID lässt sich dann nur noch aus interner Block-`id`, `blockType` und Index ableiten.

2. **Frontend: fester Wrapper um jeden gerenderten Block**  
   **`src/blocks/RenderBlocks.tsx`**
   - Ruft **`getResolvedBlockAnchorItems(blocks)`** einmal mit dem **gleichen** Layout-Array auf, das auch gespeichert/aus Payload kommt.
   - Mappt **Index → `anchorId`** und rendert **jeden** Block in ein äußeres  
     `<div id={anchorId} className={anchorId ? 'scroll-mt-44' : undefined}>`  
     (`scroll-mt-44` = Tailwind **`scroll-margin-top`**, damit fixe Header / Lenis-Ziel nicht unter der Leiste landen).
   - **`id`** ist immer die berechnete Anker-ID (oder `undefined`, falls Schritt in der Utility übersprungen wird — selten).

3. **Eine gemeinsame Berechnungslogik**  
   **`src/utilities/sectionAnchors.ts`** — `getResolvedBlockAnchorItems` / `normalizeAnchorId`  
   Reihenfolge für den **Roh**-Anker je Block (vereinfacht): gespeichertes **`anchorId`** → **`navLabel`** → **`blockName`** (falls im Datenmodell vorhanden) → **`section-{Payload-block-id}`** → **`{blockType}-{Index}`** → `section-{Index}`. Danach Normalisierung (Kleinbuchstaben, Bindestriche) und **Eindeutigkeit** bei Duplikaten (`-2`, `-3`, …).

4. **Footer ohne Layout-Block**  
   Fester Anker **`page-footer`**: **`src/Footer/Component.tsx`** setzt `id="page-footer"` auf `<footer>`. Die Link-Felder **`BlockAnchorField`** / **`BlockAnchorForPageField`** bieten diese Option zusätzlich zu den Layout-Blöcken an.

**Kurz:** Anker funktionieren, weil **dieselbe Funktion** (`getResolvedBlockAnchorItems`) im **Admin** (Picker) und in **`RenderBlocks`** (DOM-`id`) läuft — plus **ein Wrapper-`div` mit `id` und `scroll-margin`** pro Block.

### Admin — welcher Block ist wählbar?

**Datei:** `src/fields/link/BlockAnchorField.tsx`

- Liest das **aktuelle Page-Layout** aus Formular-State oder gespeicherter `data` (gleiche `layout`-Reihenfolge wie live).
- Baut dieselbe Liste mit `getResolvedBlockAnchorItems` und zeigt ein **Select**; gespeicherter Wert ist der String `anchorId` (z. B. `hero-1`, `page-footer`).
- Zusätzliche Option **`page-footer`**: feste ID für den Seitenfuß; im Frontend setzt **`src/Footer/Component.tsx`** `id="page-footer"` auf `<footer>`.

Damit sind CMS-Auswahl und gerenderte `id` **1:1** gekoppelt — keine manuelle Eingabe der Hash-Zeichenkette nötig.

### Link-Klick — `CMSLink` + `AnchorSmoothLink`

- `type === 'block'` → `rawHref = '#${normalizeAnchorId(blockAnchor)}'` (falls der Picker schon normalisierte IDs speichert, bleibt der Wert in der Praxis gleich).
- Reine Hash-URL → Rendering mit **`AnchorSmoothLink`** statt normalem `Link`-Default: `preventDefault`, Element per `document.getElementById`, dann Lenis `scrollTo` oder `scrollIntoView`, Header-Kurz-„visible“-Event, Fokus auf Ziel für Tastatur/Reader.

**Abhängigkeiten:** Lenis (`getLenisInstance`), optionale Header-Events (`src/Header/events`). Ohne Lenis fällt die Komponente auf natives `scrollIntoView` zurück.

---

## 4. Anker auf **einer anderen** Seite (`type: 'blockOnPage'`)

### Idee

Wie `block`, aber die Zielseite ist eine **andere** `pages`-Dokument-Relationship. Die URL wird **`/{slugZielseite}#anker-id`** (Slug `home` → `/`). Nach Navigation landet der Browser auf der Seite mit Hash; der Hash-Scroll beim **Seitenwechsel** übernimmt primär der Browser (nicht die gleiche `AnchorSmoothLink`-Interception wie bei `#` auf der **aktuellen** Seite).

### Payload

- **`blockOnPageReference`**: Relationship nur zu `pages`.
- **`blockOnPageAnchor`**: gleiche semantische ID wie bei `block`.

### Admin

**Datei:** `src/fields/link/BlockAnchorForPageField.tsx`

- Liest die gewählte Page-ID aus dem Formular (Sibling-Feld zur Reference).
- Lädt per **`fetch('/api/pages/{id}?depth=0&locale=…')`** das Dokument und verwendet **`doc.layout`**.
- Optionsliste wieder über `getResolvedBlockAnchorItems(layout)` — dieselben `anchorId`-Strings wie auf der Zielseite gerendert werden.
- Auch hier Option **`page-footer`**, falls der Footer auf der Zielseite dieselbe `id` hat.

### Frontend — `CMSLink`

- Basis-Pfad aus `blockOnPageReference.value.slug` (`home` → `/`).
- Hash aus `normalizeAnchorId(blockOnPageAnchor)`.
- `rawHref` ist z. B. `/kontakt#team` — **kein** reiner `#`-Link → normales **`next/link`** (der Pfadanteil wird wie andere interne Links lokalisiert; der `#…`-Teil bleibt angehängt).

**Wichtig:** Smooth-Scroll-Logik von `AnchorSmoothLink` greift hier **nicht** (nur bei `href`, die mit `#` beginnen). Cross-Page-Anker kannst du bei Bedarf mit einem `useEffect` auf der Ziel-Layout-Page nachziehen (Hash auslesen, zu `#id` scrollen); im aktuellen Stand nutzt ihr meist das Browser-Verhalten nach dem Load.

---

## 5. Kurzüberblick: Payload `link()` Feld-Factory

**Datei:** `src/fields/link.ts`

`link(options?)` erzeugt eine **`group`** mit dem Namen `link` (oder kann per `overrides` angepasst werden).

### Optionen der Factory

- **`appearances`**: `'default' | 'outline' | 'cta'` — welche `appearance`-Optionen im Admin erscheinen; `false` = kein Appearance-Feld
- **`disableLabel`**: `true` = kein `label`-Feld (z. B. wenn der sichtbare Text von außen kommt)
- **`enableActions`**: zusätzlicher Link-Typ `action` (z. B. Newsletter-Popup)
- **`localized`**: `label`, `url`, Anker-Felder mehrsprachig
- **`overrides`**: `deepMerge` auf die Group-Definition

### Link-Typen (`type`, Radio)

1. **`reference`** — Relationship zu `['pages', 'posts']`; interne URLs werden im Frontend aus `slug` und `relationTo` gebaut
2. **`custom`** — freies Textfeld `url` (kann lokalisiert sein)
3. **`block`** — `blockAnchor`: Anker auf einen Block **derselben** Seite (siehe `normalizeAnchorId`)
4. **`blockOnPage`** — `blockOnPageReference` (Page) + `blockOnPageAnchor`
5. **`action`** (nur mit `enableActions: true`) — z. B. `openNewsletterPopup`

### Weitere Felder

- **`newTab`**: Checkbox, sichtbar bei `reference`, `custom`, `blockOnPage`
- **`label`**: Anzeigetext (außer bei `disableLabel`)
- **`appearance`**: `default` / `outline` / `cta` (wenn nicht mit `appearances: false` deaktiviert)

Die Anker-Felder nutzen im Admin Custom Fields: `BlockAnchorField`, `BlockAnchorForPageField` (`src/fields/link/`), damit Redakteure sinnvolle Ziele wählen können.

---

## 6. Payload: `linkGroup()`

**Datei:** `src/fields/linkGroup.ts`

Erzeugt ein **`array`** `links`, dessen Einträge jeweils die gleiche Struktur wie `link()` haben (inkl. `appearances`, `enableActions`, `localized`). Praktisch für mehrere CTAs oder Navigationszeilen.

---

## 7. `CMSLink`: Lokalisierung, `href` aller Typen, Darstellung

**Datei:** `src/components/Link/index.tsx` (Client Component)

Props entsprechen der Payload-Gruppe: `type`, `reference`, `url`, `blockAnchor`, `blockOnPageReference`, `blockOnPageAnchor`, `action`, `label`, `newTab`, `appearance`, optional `children` / `className` / `onClick`.

Die Spezialfälle **Action**, **`block`** und **`blockOnPage`** sind in Abschnitt 2–4 beschrieben. Ergänzend:

### `href` für `reference` und `custom`

- **`reference`**: `pages` → `/${slug}` (`home` → `/`); `posts` → `/posts/${slug}`. Es muss `reference.value` ein Objekt mit `slug` sein (populate/depth), sonst kein Link.
- **`custom`**: `url` wird direkt verwendet (extern oder relativ).

### Lokalisierung

Relative interne Pfade (`/` am Anfang, kein reiner Hash, kein `https://` / `mailto:` / `tel:`) werden mit `localizePath(rawHref, locale)` aus `src/localization/paths.ts` versehen; `locale` aus `usePathname()` via `getLocaleFromPathname`.

### Darstellung

- `appearance` z. B. `inline`, `animatedUnderline`, oder Button über `Button` + `asChild` mit `next/link`.
- Reine Hash-URLs → **`AnchorSmoothLink`** (siehe Abschnitt 3).

---

## 8. Rich-Text: Lexical `LinkFeature` (CMS-Link im Fließtext)

**Editor:** `src/fields/defaultLexical.ts`

- `LinkFeature` mit `enabledCollections: ['pages', 'posts']`
- Das `url`-Feld wird so überschrieben, dass es nur bei **nicht-internen** Links Pflicht ist; interne Links validieren ohne URL

**Rendering:** `src/components/RichText/index.tsx`

- `LinkJSXConverter({ internalDocToHref })`
- `internalDocToHref` baut aus `linkNode.fields.doc` die URL:  
  `posts` → `/posts/{slug}`, sonst `/{slug}`

**Hinweis für Migration:** Die Rich-Text-Href-Logik ist **getrennt** von `CMSLink` implementiert. Wenn du z. B. den Slug `home` immer als `/` brauchst, musst du dieselbe Regel **auch** in `internalDocToHref` ergänzen (im aktuellen Stand kann sich das von `CMSLink` unterscheiden).

---

## 9. Verwandte Utilities

| Modul                             | Rolle                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/utilities/sectionAnchors.ts` | `normalizeAnchorId`, Auflösung von Block-Ankern aus dem Page-Layout für Nav/Admin-Picker    |
| `src/localization/paths.ts`       | `localizePath`, `getLocaleFromPathname`, `buildLocalizedPagePath`, `buildLocalizedPostPath` |

---

## 10. Review: Kann man das in einem **neuen** Payload-Projekt umsetzen?

**Kurzantwort: Ja.** Es handelt sich um normale Payload-Felder, REST-genutzte Admin-Components und Next.js-Frontend-Code — nichts proprietär Payload-Internes. Du portierst **Dateien + Konventionen** und passt **Slugs, Types und Abhängigkeiten** an.

### Was am Code überprüft wurde

| Baustein                      | Tragfähigkeit      | Hinweis für Greenfield                                                                                                                                                                                                              |
| ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link()` / `linkGroup()`      | ✅                 | `relationTo: ['pages', 'posts']` und Feldnamen `link.*` sind im Code **fest** — Collection-Slugs oder `layout`-Feldnamen anders → `link.ts` + Types + `CMSLink` anpassen.                                                           |
| `BlockAnchorField`            | ✅                 | Liest `layout` aus **derselben Page**, die im Admin bearbeitet wird; nutzt `getLayoutFromFieldMap` für Payload-Form-Pfade. Neues Projekt braucht ein **blocks-Array auf der Page** (oder du mapst die Utility auf euren Feldnamen). |
| `BlockAnchorForPageField`     | ✅, aber gekoppelt | Fetch: **`/api/pages/${id}?depth=0&locale=…`** — Collection muss **`slug: 'pages'`** heißen (oder URL in der Datei ändern). `doc.layout` muss die **gleiche Block-Struktur** haben wie im Frontend.                                 |
| `getResolvedBlockAnchorItems` | ✅                 | Importiert `Page` aus **`payload-types`** — im Zielprojekt Types neu erzeugen; Block-Interface muss `blockType`, `id`, optional Nav-Felder tragen.                                                                                  |
| `RenderBlocks`                | ✅ Muster          | Beliebiges Layout: solange du **`getResolvedBlockAnchorItems` + `id` auf Wrapper** einhältst, stimmen Picker und DOM überein.                                                                                                       |
| `CMSLink`                     | ✅                 | Setzt **Next.js** `Link` + `usePathname` voraus. Ohne i18n: `localizePath` durch Identitätsfunktion oder Prefix-Logik ersetzen.                                                                                                     |
| `AnchorSmoothLink`            | optional           | Funktioniert ohne Lenis (Fallback `scrollIntoView`); Header-Events können stubben oder entfernen.                                                                                                                                   |
| `enableActions`               | optional           | Newsletter-Event + Popup sind **App-spezifisch** — weglassen oder durch eigene Events ersetzen.                                                                                                                                     |
| Lexical `LinkFeature`         | separater Pfad     | Muss **nicht** mit Block-Ankern übereinstimmen; nur `internalDocToHref` konsistent zu euren Routen halten.                                                                                                                          |

### Stufenweise Einführung (empfohlen)

1. **Minimal:** Nur `link()` für `reference` + `custom` + schlankes `CMSLink` (ohne `block` / `blockOnPage` / `action`) — wenige Dateien, schnell nutzbar.
2. **+ Anker:** `sectionAnchors.ts` + `sectionNavigationFields` in Blocks + `RenderBlocks`-Wrapper + `BlockAnchorField` + Import Map — dann Typ `block`.
3. **+ andere Seite:** `BlockAnchorForPageField` + REST-Zugriff aus Admin + Typ `blockOnPage`.
4. **+ Aktionen:** `enableActions` + Event-Bus + Subscriber-Komponente.
5. **Polish:** Lenis, `scroll-mt-*`, Footer-`id`, Rich-Text-`internalDocToHref` = gleiche Regeln wie `CMSLink`.

### Harte Voraussetzungen (wenn du alles 1:1 willst)

- **Next.js** (App Router) für `CMSLink` unverändert; anderes Framework → Link-Komponente und Router-Hooks ersetzen.
- **`payload generate:importmap`** nach Einbinden der Custom Field-Pfade unter `admin.components` / Feld `components.Field`.
- **Layouts:** Page-Dokument mit **`layout`** (oder umbenennen und `sectionAnchors` + Field-Resolver anpassen — `BlockAnchorField`’s `getLayoutFromFieldMap` sucht explizit nach `layout`).

### Bekannte Doppelstellen beim Port

- URL-Logik **zweimal** pflegen, wenn du Lexical nutzt: `CMSLink` **und** `internalDocToHref` (z. B. `home` → `/`).
- **`deepMerge`** in `link.ts`: im Lamedica-Projekt unter `src/utilities/deepMerge.ts`; im neuen Projekt gleiche Hilfsfunktion oder `overrides` weglassen.

---

## 11. Checkliste: Übernahme in ein anderes Projekt

1. **Payload**
   - `link.ts`, `linkGroup.ts`, optional `fields/link/*` (Admin)
   - Collections mit `slug`, Relationships wie in `link.ts`; Page mit **Blocks-Array** für Anker
   - `generate:types`, danach `sectionAnchors`/Types-Kopplung prüfen
   - `payload generate:importmap` für `#BlockAnchorField` / `#BlockAnchorForPageField`

2. **Frontend**
   - `CMSLink` + bei Bedarf `AnchorSmoothLink`
   - `Button` / UI; `AnimatedCTAContent` nur nötig, wenn ihr CTA-Appearances behaltet
   - Lokalisierung übernehmen oder in `CMSLink` vereinfachen
   - Block-Rendering: Wrapper mit `id` + `getResolvedBlockAnchorItems`

3. **Rich-Text**
   - `LinkFeature` + `LinkJSXConverter` + eine zentrale **`internalDocToHref`** (DRY zu `CMSLink`)

4. **Optional**
   - Lenis + Header-Events
   - `enableActions` + globales CustomEvent + Listener-UI

---

## 12. Nutzungsbeispiele im Code (Referenz)

- Blöcke: `CMSLink {...link}` in z. B. `Content`, `CallToAction`, `CenteredContent`
- Header/Footer/Popup: `CMSLink` mit `appearance` und Klassen
- Schema: `link({ enableActions: true, localized: true, … })` in Block-Configs

Damit lässt sich das Muster **„einheitliche Link-Datenstruktur im CMS + eine Render-Komponente + separater Lexical-Pfad“** in anderen Next.js/Payload-Projekten nachbauen — die Machbarkeit ist gegeben, sofern die Tabelle in **Abschnitt 10** zu eurer Collection- und Routing-Struktur passt bzw. bewusst angepasst wird.
