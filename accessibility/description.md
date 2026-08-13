# Barrierefreiheit — Standard-Check für jedes Projekt (Payload + Next.js)

Der wiederkehrende Teil: was **in jedem** Projekt geprüft und einmal sauber gebaut werden muss, damit WCAG 2.1 AA erreichbar ist — Tooling, Payload-Konfiguration, Frontend-Basics und eine manuelle Prüfroutine, die in 15 Minuten läuft.

> **Keine Rechtsberatung.** Geltungsbereich und Fristen unten sind eine Einordnung für die Projektplanung; die verbindliche Bewertung macht der Kunde bzw. dessen Jurist.

## 1. Gilt das überhaupt? (BFSG / BaFG)

Seit **28. Juni 2025** gelten das deutsche **BFSG** und das österreichische **BaFG** (beide setzen den European Accessibility Act, Richtlinie 2019/882, um). Beide verweisen über **EN 301 549** auf **WCAG 2.1 Level AA** als Mindeststandard.

**Betroffen** sind vor allem Websites, über die Verbraucher eine Dienstleistung abschließen oder abwickeln: Online-Shops, Buchungs- und Terminstrecken, Kundenkonten, Bank-/Versicherungs-/Reise-/Telekommunikationsdienste — inklusive der Info-Seiten, die zu einem betroffenen Produkt oder Dienst gehören.

**Nicht bzw. eingeschränkt betroffen:**

- **Kleinstunternehmen**, die *Dienstleistungen* anbieten: < 10 Mitarbeitende **und** ≤ 2 Mio. € Jahresumsatz/Bilanzsumme → ausgenommen. Für *Produkte* gelten vereinfachte Regeln, keine volle Ausnahme.
- **Reines B2B** — aber nur, wenn erkennbar ausschließlich an Unternehmen gerichtet. Sobald Verbraucher denselben Abschluss nutzen können, greift das Gesetz.
- **Reine Visitenkarten-Websites** ohne Vertragsabschluss/Dienstleistung sind i. d. R. nicht erfasst.

Bußgelder in Österreich: bis 80.000 € (große Unternehmen), 50.000 € (KMU), 25.000 € (Kleinstunternehmen).

→ **Für die Angebotsphase:** Die Ausnahme ist enger, als Kunden hoffen — „wir sind ja nur ein kleines Büro" hilft nur, wenn **beide** Schwellen unterschritten sind. Und: Ein Kontaktformular ist noch kein Vertragsabschluss, ein Terminbuchungs-Widget oder ein Kundenlogin schon eher. **Im Zweifel technisch auf AA bauen** — der Aufwand ist bei einem Neuprojekt gering, die Nachrüstung teuer.

→ **Informationspflicht:** Betroffene Dienstleister müssen auf der Website darlegen, **wie** die Dienstleistung die Anforderungen erfüllt, plus eine Kontaktmöglichkeit für Barriere-Meldungen. In der Praxis: eine **„Erklärung zur Barrierefreiheit"** als Payload-Page, im Footer neben Impressum/Datenschutz verlinkt (siehe Abschnitt 7).

## 2. Erwartungsmanagement: Was Tools finden können

Automatisierte Prüfung (axe, Lighthouse, ESLint) findet je nach Quelle nur **etwa ein Drittel bis die Hälfte** der WCAG-Verstöße — alles Strukturelle (fehlende Labels, Kontraste, doppelte IDs, ARIA-Fehler). **Nicht** automatisch prüfbar: ob der Alt-Text inhaltlich stimmt, ob die Fokus-Reihenfolge sinnvoll ist, ob Fehlermeldungen verständlich sind, ob eine Bedienung ohne Maus wirklich funktioniert.

→ Deshalb dieser Skill in drei Teilen: **CI-Gate** (Abschnitt 3), **einmalige Bau-Entscheidungen** (4 + 5), **manuelle Routine pro Projekt** (6). Ein grüner Lighthouse-Score von 100 ist **kein** Konformitätsnachweis — das gehört so auch in die Kundenkommunikation.

## 3. Tooling

### 3.1 ESLint — verhindert die Klassiker beim Schreiben

`eslint-config-next` enthält nur eine **Teilmenge** der jsx-a11y-Regeln. Explizit auf `strict` heben:

```bash
pnpm add -D eslint-plugin-jsx-a11y
```

```js
// eslint.config.mjs (Flat Config)
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  jsxA11y.flatConfigs.strict,
  {
    rules: {
      // Bewusste Abweichungen hier dokumentieren, statt Regeln stumm zu deaktivieren:
      'jsx-a11y/no-autofocus': 'warn',
    },
  },
]
```

→ Fängt genau die Fehler, die sonst durchrutschen: `<img>` ohne `alt`, `onClick` auf `<div>`, `<label>` ohne `htmlFor`, `href="#"`, positive `tabIndex`.

### 3.2 axe in der CI — der eigentliche Gate

```bash
pnpm add -D @playwright/test @axe-core/playwright
```

```ts
// tests/a11y.spec.ts
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Die Seitenliste aus der Sitemap ziehen, statt sie zu pflegen —
// so wächst der Test automatisch mit dem CMS-Inhalt mit.
const urlsFromSitemap = async (): Promise<string[]> => {
  const res = await fetch(`${process.env.BASE_URL}/sitemap.xml`)
  const xml = await res.text()
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, 25)
}

test.describe('Barrierefreiheit', () => {
  test('keine WCAG-2.1-AA-Verstöße', async ({ page }) => {
    const violations: string[] = []

    for (const url of await urlsFromSitemap()) {
      await page.goto(url)
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      for (const v of result.violations) {
        violations.push(`${url} — ${v.id} (${v.nodes.length}×): ${v.help}`)
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
```

→ **Sitemap als Testmatrix** ist der Trick, der den Test in einem CMS-Projekt am Leben hält (`next-sitemap` steht schon im [`seo/`](../seo/description.md)-Setup). Bei großen Sites auf ein Sample begrenzen — **eine Seite pro Template/Block-Kombination** ist aussagekräftiger als 200 Blog-Posts.

→ **Interaktive Zustände mittesten.** Ein axe-Lauf auf der frisch geladenen Seite sieht weder das geöffnete Popup, das Mobile-Menü noch den Fehlerzustand des Formulars — genau dort sitzen die Fehler. Für jede dieser Komponenten einen eigenen Test, der den Zustand erst öffnet und dann `analyze()` ruft.

### 3.3 Dev-Feedback im Browser (optional)

`@axe-core/react` protokolliert Verstöße live in der Konsole. Nur im Dev-Build laden, sonst wandert axe-core (~500 kB) ins Prod-Bundle.

### 3.4 Lighthouse — Verhältnis zum Go-Live-Gate

[`lighthouse-check/`](../lighthouse-check/description.md) fordert vor jedem Go-Live **Accessibility ≥ 95**. Das ist als Rauchmelder richtig und soll so bleiben — es prüft aber nur eine Teilmenge der axe-Regeln auf **einer** URL im Ausgangszustand.

→ **Score 100 ≠ WCAG-konform.** Die häufigsten Befunde (Tastaturfalle im Popup, unsichtbarer Fokus, unsinnige Alt-Texte, nicht angesagte Formularfehler) sieht Lighthouse prinzipbedingt nicht. Der Lighthouse-Gate schließt den axe-Lauf über die Sitemap (3.2) und die manuelle Routine (Abschnitt 6) also **nicht** ein, sondern setzt nur die Untergrenze.

## 4. Payload-Konfiguration — was Redakteure gar nicht erst falsch machen können sollen

### 4.1 Alt-Texte inkl. dekorativer Bilder

`required: true` auf `Media.alt` (siehe [`seo/`](../seo/description.md)) hat einen Haken: **dekorative** Bilder brauchen einen *leeren* Alt-Text (`alt=""`), damit Screenreader sie überspringen. Ein erzwungener Text macht sie zu Lärm. Deshalb ein explizites Flag statt blanker Pflicht:

```ts
// src/collections/Media.ts
fields: [
  {
    name: 'isDecorative',
    type: 'checkbox',
    label: 'Rein dekoratives Bild',
    admin: { description: 'Nur ankreuzen, wenn das Bild keine Information trägt (Muster, Verlauf, Deko).' },
  },
  {
    name: 'alt',
    type: 'text',
    label: 'Alt-Text',
    admin: {
      condition: (_, siblingData) => !siblingData?.isDecorative,
      description: 'Was ist zu sehen — im Kontext der Seite? Kein „Bild von“, keine Dateinamen.',
    },
    // Kein `required: true`: das würde auch bei angehaktem Flag serverseitig greifen.
    validate: (value: string | null | undefined, { siblingData }: { siblingData: Record<string, unknown> }) =>
      siblingData?.isDecorative || Boolean(value?.trim()) || 'Alt-Text ist erforderlich.',
  },
]
```

→ **`admin.condition` allein reicht nicht.** Sie blendet das Feld nur im Admin aus; die serverseitige `required`-Validierung läuft trotzdem und blockiert dann das Speichern dekorativer Bilder. Darum die `validate`-Funktion.

Im Frontend das Attribut **immer** rendern, nie weglassen:

```tsx
<Image alt={resource.isDecorative ? '' : (resource.alt ?? '')} {...props} />
```

### 4.2 Überschriften-Hierarchie im Lexical-Editor beschränken

Die häufigste strukturelle Barriere in CMS-Projekten: Redakteure setzen `h1` im Fließtext oder springen von `h2` auf `h4`.

```ts
// src/collections/Pages.ts (bzw. zentrale Editor-Config)
import { HeadingFeature, lexicalEditor } from '@payloadcms/richtext-lexical'

editor: lexicalEditor({
  features: ({ defaultFeatures }) => [
    ...defaultFeatures,
    // Gleicher Feature-Key ⇒ überschreibt das Default-Heading-Feature.
    HeadingFeature({ enabledHeadingSizes: ['h2', 'h3', 'h4'] }),
  ],
}),
```

→ Das `h1` gehört ins Seiten-Template (aus `doc.title` bzw. dem Hero-Block), **nicht** in den Rich-Text. Ergänzend im Block-Schema von Section-Headings ein `headingLevel`-Select (`h2`/`h3`) anbieten, damit die Hierarchie auch über Blöcke hinweg stimmt — Optik über eine separate `size`-Prop steuern, nicht über die Tag-Wahl.

### 4.3 Linktexte

Im `link()`-Feld (siehe [`advanced-link/`](../advanced-link/description.md)):

- `label` **required** — sonst rendert der Button leer oder mit URL-Text.
- „Mehr", „Hier klicken", „Weiterlesen" sind out of context nicht unterscheidbar (WCAG 2.4.4). Entweder redaktionell im `admin.description` verlangen oder im Frontend automatisch ergänzen: `aria-label={`${label}: ${docTitle}`}`.
- `newTab`: Screenreader kündigen den neuen Tab nicht an → visuell verstecktes „(öffnet in neuem Fenster)" ergänzen und `rel="noopener noreferrer"` setzen.

### 4.4 Formulare (Form Builder)

- Jedes Feld braucht ein sichtbares `<label htmlFor>`. **Placeholder ersetzen kein Label** — er verschwindet beim Tippen und hat oft zu wenig Kontrast.
- Pflichtfelder: `required` am Input (nicht nur ein Sternchen im Label) und die Bedeutung des Sternchens einmal erklären.
- Fehler mit `aria-describedby` an das Feld hängen, Fehlertext in einen Container mit `role="alert"`, und nach dem Absenden den Fokus auf die Fehler-Zusammenfassung setzen — sonst merkt ein Screenreader-Nutzer nicht, dass überhaupt etwas passiert ist.
- **Honeypot** (siehe [`honey-pot-capcha/`](../honey-pot-capcha/description.md)): `aria-hidden="true"` **plus** `tabIndex={-1}` und `autoComplete="off"`. Nur `display:none` reicht nicht, nur `aria-hidden` auch nicht — ohne `tabIndex={-1}` tabbt man hinein.
- **ALTCHA**: läuft automatisch und ohne Interaktion, ist damit deutlich barriereärmer als ein Bild-Captcha — das ist ein gutes Argument gegenüber reCAPTCHA. Das Widget trotzdem mit sichtbarem Statustext einbinden, damit der Fortschritt angesagt wird.

## 5. Frontend-Standards — einmal ins Template, dann nie wieder

### 5.1 Skip-Link und Landmarks

```tsx
// src/app/(frontend)/layout.tsx
<a
  href="#main"
  className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2"
>
  Zum Hauptinhalt springen
</a>
<Header />        {/* enthält <nav aria-label="Hauptnavigation"> */}
<main id="main" tabIndex={-1}>{children}</main>
<Footer />        {/* <footer> */}
```

→ `tabIndex={-1}` am `<main>` ist nötig, damit der Sprung den Fokus wirklich mitnimmt (sonst springt nur der Viewport). Bei mehreren `<nav>` pro Seite jedes mit eigenem `aria-label`.

→ `<html lang="de">` korrekt setzen — im Website-Template steht `lang="en"`.

### 5.2 Fokus-Indikator nicht wegstylen

```css
/* globals.css */
@layer base {
  :focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: 2px;
  }
}
```

→ **Der Klassiker:** `outline-none` an Buttons/Inputs (kommt über viele UI-Kits mit), ohne Ersatz → WCAG 2.4.7 verletzt. Der Indikator braucht selbst **3:1** Kontrast zum Hintergrund. `:focus-visible` statt `:focus` verwenden, damit Mausklicks keinen Ring hinterlassen.

### 5.3 Kontraste an den Tokens prüfen, nicht pro Komponente

4.5:1 für Fließtext, 3:1 für großen Text (≥ 24 px bzw. ≥ 18,66 px fett) und für UI-Elemente/Grenzen. Das gehört **einmal** in die Token-Definition (siehe [`northlight-global-css/`](../northlight-global-css/description.md)) — dort einmal geprüft, gilt es überall.

→ Typische Fallen: helles Grau für Sekundärtext, Placeholder-Grau, Marken-Gelb/Hellgrün auf Weiß, Text über Bild ohne Overlay, Disabled-Zustände (die sind ausgenommen, `aria-disabled`-Elemente aber **nicht**).

### 5.4 `prefers-reduced-motion` — inklusive Lenis

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

→ **CSS allein genügt nicht**, wenn Smooth-Scrolling per JS läuft. Lenis (siehe [`pop-up/`](../pop-up/description.md)) muss abgeschaltet werden — es ignoriert `scroll-behavior`:

```ts
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (!reduce) lenis.start()
else lenis.destroy()
```

Dasselbe gilt für Autoplay-Slider und Parallax-Effekte.

### 5.5 Dialoge, Popup und Cookie-Banner

Für Modals **Radix Dialog** (bzw. shadcn) nutzen statt Eigenbau — Fokus-Trap, `aria-modal`, Escape, Fokus-Rückgabe und Hintergrund-`inert` kommen fertig mit. Zu prüfen bleibt:

- **`DialogTitle` ist Pflicht** — ohne ihn hat der Dialog keinen zugänglichen Namen (Radix warnt in der Konsole). Wenn er visuell nicht erscheinen soll: `sr-only`, nicht weglassen.
- **Lenis pausieren**, solange der Dialog offen ist (`lenis.stop()` / `.start()`), sonst scrollt der Hintergrund unter dem Modal weg.
- **Auto-öffnende Marketing-Popups**: müssen per Escape schließbar sein und den Fokus danach dorthin zurückgeben, wo er war. Ein Popup, das beim Laden aufgeht und den Fokus verschluckt, ist der schlimmste Einzelfehler auf einer Website.
- **Cookie-Banner** (c15t, siehe [`tracking/`](../tracking/description.md)): komplett per Tastatur bedienbar, „Ablehnen" gleich prominent wie „Akzeptieren" (ohnehin datenschutzrechtlich nötig), und der Fokus muss beim Erscheinen in den Banner wandern. **Immer im axe-Test mitprüfen** — der Banner ist auf jeder Seite das erste, was ein Nutzer trifft, und wird beim Testen regelmäßig vorher weggeklickt.

### 5.6 Weitere Standardpunkte

- **Zoom/Reflow:** bei 320 px Breite bzw. 400 % Zoom kein horizontales Scrollen (WCAG 1.4.10). Fixe `width`-Werte und `overflow: hidden` sind die üblichen Verursacher.
- **Touch-Targets:** mind. 24×24 px (WCAG 2.2). Pflicht ist aktuell 2.1 AA — 2.2 lässt sich bei einem Neubau ohne Mehraufwand mitnehmen.
- **Videos:** Untertitel sind AA-Pflicht. Auto-Play mit Ton nie; bei > 5 s Bewegung Pause-Button.
- **Icon-Buttons** (Burger-Menü, Suche, Schließen) brauchen `aria-label`; das Icon selbst `aria-hidden`.
- **Text in Bildern** vermeiden — u. a. weil Zoom ihn zerstört.

## 6. Manuelle Routine pro Projekt (15 Minuten)

Auf einer repräsentativen Seite plus Formular- und Checkout-/Kontaktstrecke:

1. **Nur Tastatur:** `Tab` durch die ganze Seite. Ist der Fokus **immer sichtbar**? Ist die Reihenfolge logisch? Kommt man aus Menü/Modal/Banner wieder heraus? Ist der Skip-Link der erste Stopp?
2. **Zoom 400 %** (bzw. Viewport 320 px): kein horizontales Scrollen, nichts überlappt, nichts abgeschnitten.
3. **Screenreader-Struktur:** VoiceOver (`Cmd+F5`) → Rotor (`Ctrl+Opt+U`) → Überschriften- und Landmark-Liste. Ergibt die Liste ohne die Seite zu sehen einen Sinn? Genau ein `h1`?
4. **Formular:** leer absenden. Werden Fehler angesagt, sind sie dem Feld zugeordnet, landet der Fokus dort?
5. **Bilder:** Alt-Texte stichprobenartig lesen — beschreiben sie den Inhalt oder stehen da Dateinamen?
6. **`prefers-reduced-motion`** im OS aktivieren und die Seite neu laden: steht alles still, inklusive Smooth-Scroll?

→ Punkte 1 und 6 finden erfahrungsgemäß mehr echte Probleme als jeder automatisierte Lauf.

## 7. Erklärung zur Barrierefreiheit

Als normale Payload-Page anlegen, im Footer verlinken, Inhalt:

- Welchen Standard die Site anstrebt (WCAG 2.1 AA / EN 301 549) und **Stand der Umsetzung**.
- **Bekannte, noch nicht barrierefreie Bereiche** ehrlich benennen (z. B. eingebettete Drittanbieter-Widgets, alte PDFs) — samt geplanter Behebung.
- **Feedback-Kontakt** (E-Mail/Formular), über den Barrieren gemeldet werden können, plus Reaktionszeit.
- Datum der letzten Prüfung und wie geprüft wurde (Tool + manuell).

→ Kein Copy-Paste-Text: Die Erklärung ist eine **Selbstauskunft**. Steht dort „vollständig barrierefrei", während der Cookie-Banner nicht tastaturbedienbar ist, ist das schlechter als eine ehrliche Teil-Konformität.

## Quick-Checkliste für ein neues Projekt

1. Geltungsbereich klären (Dienstleistung für Verbraucher? Kleinstunternehmen-Schwellen?) und im Angebot festhalten
2. `eslint-plugin-jsx-a11y` auf `flatConfigs.strict`
3. Playwright + `@axe-core/playwright`, Seitenliste aus `sitemap.xml`, **plus** eigene Tests für Popup, Mobile-Menü, Cookie-Banner und Formular-Fehlerzustand
4. `Media`: `isDecorative`-Flag + `validate` statt `required` auf `alt`; Frontend rendert `alt=""` statt gar keinem Attribut
5. Lexical: `HeadingFeature({ enabledHeadingSizes: ['h2','h3','h4'] })`; `h1` nur aus dem Template
6. Skip-Link + `<main id="main" tabIndex={-1}>` + `<html lang="de">` + benannte Landmarks
7. `:focus-visible`-Outline global; kein `outline-none` ohne Ersatz
8. Farb-Tokens einmal auf 4.5:1 / 3:1 prüfen
9. `prefers-reduced-motion` in CSS **und** Lenis/Slider/Parallax
10. Dialoge über Radix, `DialogTitle` immer gesetzt, Lenis währenddessen gestoppt
11. Formulare: Label + `aria-describedby` + `role="alert"` + Fokus auf Fehler; Honeypot `aria-hidden` **und** `tabIndex={-1}`
12. Manuelle 15-Minuten-Routine vor Abnahme
13. „Erklärung zur Barrierefreiheit" als Page + Footer-Link, mit ehrlicher Einschränkungsliste
