# cn() & tailwind-merge — Custom Utilities richtig registrieren

Warum unser `cn()` aus `src/utilities/ui.ts` nicht das blanke `twMerge` benutzt, sondern ein `extendTailwindMerge`. Diese Datei beschreibt das **Konzept**, damit es nach jedem Reset / Reinstall / Re-Scaffold wieder rekonstruiert werden kann. Die konkreten Klassennamen sind austauschbar — der Mechanismus ist das Wichtige.

## Das Problem

`tailwind-merge` löst Klassen-Konflikte auf, indem es Utilities in **Class-Groups** einteilt. Innerhalb einer Gruppe gewinnt die letzte Klasse, alle vorherigen werden entfernt. Dafür hat tailwind-merge eine **fest verdrahtete Liste** der Standard-Tailwind-Utilities.

Unsere eigenen Typografie-Tokens (aus `globals.css` via `@theme --text-*`, z.B. `text-copy`, `text-h1`, `text-zitat`) sind tailwind-merge **unbekannt**. Es kennt nur das `text-` Präfix und steckt sie deshalb in die falsche Schublade:

```tsx
// Intention: Schriftgröße `text-copy` + Farbe `text-foreground`
cn('text-copy', 'text-foreground')

// → tailwind-merge sieht ZWEI `text-*` Klassen, hält sie für einen Konflikt
// → behält nur die letzte → 'text-foreground'
// → die Schriftgröße verschwindet lautlos. Kein Error, kein Warning.
```

Das Tückische: Es **failt still**. Das Markup sieht korrekt aus, der Output ist falsch. Typisch tritt es bei richText-Body-Typografie auf, wo Größen-Token und Farb-/Weight-Utilities am selben Element zusammenkommen.

## Die Lösung

`extendTailwindMerge` benutzen und die eigenen Tokens explizit der richtigen Class-Group zuordnen. Schriftgrößen-Token gehören in `font-size` — dann liegen sie in derselben Gruppe wie Tailwinds eigene `text-sm` / `text-lg` und kollidieren **nicht** mehr mit Farb-Utilities (`text-foreground` lebt in der Gruppe `text-color`).

```ts
// src/utilities/ui.ts
import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Unsere @theme --text-* Tokens als font-sizes registrieren.
// Ohne das hält tailwind-merge z.B. `text-copy` + `text-foreground`
// für zwei konkurrierende `text-*` Klassen und droppt die font-size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-h1',
        'text-h2',
        'text-h3',
        'text-zitat',
        'text-copy',
        'text-small-semibold',
        'text-small',
        'text-button',
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

→ `extend` (nicht `override`) verwenden: Es **ergänzt** die Standard-Gruppe, statt sie zu ersetzen. Tailwinds eingebaute `text-*` Größen bleiben damit weiter erkannt.

## Wann muss das angefasst werden

→ **Jedes Mal, wenn ein neuer Custom-Token mit Tailwind-Präfix-Kollision dazukommt.** Sobald in `globals.css` ein `--text-*` (oder ein anderes Token, dessen generierter Klassenname ein Standard-Präfix teilt) angelegt wird, muss der Name **hier in die passende Class-Group eingetragen werden** — sonst strippt `cn()` ihn lautlos.

→ Das gilt nicht nur für `font-size`. Dasselbe Muster greift für jede selbstgebaute Utility, die einen Präfix-Namespace mit Tailwind teilt (z.B. eigene `shadow-*`, `rounded-*`, `z-*` Tokens → jeweilige Group ergänzen).

→ Faustregel zum Erkennen der richtigen Gruppe: *Welche zwei Klassen sollen am selben Element koexistieren dürfen?* Wenn sie koexistieren sollen, müssen sie in **unterschiedlichen** Class-Groups liegen. Wenn sie sich gegenseitig ersetzen sollen, in **derselben**.

## Quick-Checkliste

1. `cn()` benutzt `extendTailwindMerge`, nicht das blanke `twMerge`.
2. Alle Custom-`--text-*` Tokens aus `globals.css` sind in `classGroups.font-size` gelistet.
3. `extend` verwendet (additiv), nicht `override` (ersetzend).
4. Neuer Custom-Token angelegt? → Klassenname in die passende Class-Group eintragen.
5. Bug-Symptom „Schriftgröße / Utility verschwindet ohne Fehler" → zuerst hier prüfen.
6. Konzept-Test: Klassen, die koexistieren sollen, in unterschiedliche Groups; Klassen, die sich ersetzen sollen, in dieselbe.
