# Globale Variablen und eigenes CSS im Payload-/Tailwind-4-Template

Alles, was in `src/app/(frontend)/globals.css` steht. Die Tokens selbst
(Farben, Typografie, Spacing) kommen aus dem Design — wie man sie zieht und was
dabei zu prüfen ist, steht in [env-infisical](../env-infisical/description.md)
nicht, sondern gehört zur Projekt-Doku. Hier geht es um die Fallen der Datei.

## Eigene Regeln gehören **nicht** in `@layer utilities`

Der teuerste Fehler in dieser Datei, weil er still ist.

Tailwind 4 liest Regeln innerhalb von `@layer utilities` als **Utility-
Definitionen** — nicht als gewöhnliches CSS. Komplexe Selektoren überleben das
nicht. Gemessen an frechinger (Tailwind 4.3, Next 16):

```css
/* geschrieben — in @layer utilities */
@layer utilities {
  body:has([data-hero='fullBleed']) .site-header {
    color: var(--color-brand-04);
  }
}
```

```css
/* im gebauten CSS angekommen */
.site-header{color:var(--color-brand-04)}
```

Der `body:has(...)`-Teil ist weg. Die Regel gilt damit **immer** statt nur im
gemeinten Fall. In diesem Fall: ein Header, der auf jeder Seite hell läuft statt
nur über dem vollflächigen Hero.

→ **Warum es niemand merkt:** Die betroffenen Kindelemente setzen ihre Farbe oft
selbst (Navigation über `CMSLink`), also sieht die Seite richtig aus. Auffallen
würde es erst an der einen Stelle, die erbt.

**Richtig:** solche Regeln als normales CSS ablegen, außerhalb jeder `@layer` —
am Ende der Datei, nach den Layer-Blöcken.

```css
/* globals.css, ganz unten, ohne @layer */
body:has([data-hero='fullBleed']) .site-header {
  color: var(--color-brand-04);
}
```

In `@layer utilities` gehört nur, was wirklich eine Utility ist: eine Klasse ohne
Kombinator, die man im Markup verwendet (`.container`, `.full-bleed`).

**Gegenprüfen — in der Quelle reicht nicht:**

```bash
grep -oE 'body:has\([^{]*\{[^}]*\}' .next/static/chunks/*.css
# Nicht die BRE-Form 'body:has([^{]*){…}' — die verlangt ein `)` direkt vor `{`
# und findet `body:has(…) .site-header{…}` deshalb nie, auch wenn die Regel da ist.
```

Kommt nichts zurück, ist der Selektor unterwegs verloren gegangen.

## Die `dark`-Variante nicht ersatzlos löschen

Kennt das Design keinen Dark Mode, liegt es nahe, `@custom-variant dark` zu
entfernen. Das ist falsch herum: **Ohne die Zeile fällt Tailwind 4 auf seinen
Default `prefers-color-scheme: dark` zurück** — und die `dark:`-Utilities, die in
jeder shadcn-Primitive stecken (`dark:ring-*`, `dark:outline-*`,
`dark:aria-invalid:*`), feuern plötzlich nach der Betriebssystem-Einstellung des
Besuchers.

Die Variante stehen lassen und auf ein Attribut zeigen, das niemand setzt:

```css
/* Kein Dark Mode. Die Variante bleibt als Stillstellung stehen. */
@custom-variant dark (&:is([data-theme='dark'] *));
```

## `html { opacity: 0 }` ist eine Sichtbarkeitsfalle

Das offizielle Website-Template versteckt das Dokument, bis sein `InitTheme`-
Skript ein `data-theme` gesetzt hat:

```css
html { opacity: 0; }
html[data-theme='dark'], html[data-theme='light'] { opacity: initial; }
```

Wer den Theme-Provider entfernt (kein Dark Mode) und diese Regel stehen lässt,
hat eine **komplett unsichtbare Seite**. Build grün, Typecheck grün, HTML
vollständig, keine Konsolenmeldung. Beim Entfernen des Dark Modes gehört die
Regel mit raus.

## Container und Breakpoints aus dem Design statt aus dem Template

Die Template-Defaults (`sm` 40rem … `2xl` 86rem) haben mit dem Design nichts zu
tun. Stehen im Figma-Frame Namen wie „Mobile minimal 360px 3 %" und
„Inhaltsbreite 1288px", lässt sich beides exakt und ohne Stufen abbilden:

```css
.container {
  width: 100%;
  max-width: 80.5rem;   /* 1288px */
  margin-inline: auto;
  padding-inline: 3%;
}
```

Bei 360 px sind 3 % genau 10,8 px, bei 1512 px greift die `max-width`. Dazu eine
`.full-bleed`-Utility für die Abschnitte, die bewusst ausbrechen (Hero, Laufband,
Slider):

```css
.full-bleed {
  width: 100vw;
  margin-inline: calc(50% - 50vw);
}
```

→ Nicht gebrauchte Breakpoints (`xl`, `2xl`) ersatzlos entfernen — aber vorher
prüfen, ob `@custom-variant` oder `.container`-Stufen noch auf sie verweisen,
sonst bricht `theme(--breakpoint-xl)`.

## Verwandt

- [tailwind-extended-merge](../tailwind-extended-merge/description.md) — jeder
  neue `--text-*`-Token muss zusätzlich in `cn()` registriert werden, sonst wirft
  `tailwind-merge` die Schriftgröße lautlos weg.
