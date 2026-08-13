# Lenis — die vier Bugs, die jedes Projekt mit Smooth Scrolling bekommt

Lenis übernimmt im Root-Modus den Seiten-Scroll komplett. Damit funktionieren mehrere Dinge nicht mehr, die man vom Browser gewohnt ist — und zwar **still**, ohne Fehlermeldung. Alle Fälle hier sind in `rtbrick` aufgetreten und behoben (Commits `82af887`, `734a3d6`, `56c2373`).

## 1. Nach einem Seitenwechsel steht man mitten auf der Seite

**Symptom:** Man klickt auf der Startseite weit unten eine Karte an, die Zielseite öffnet sich **an derselben Scroll-Position** statt oben. Ein Reload behebt es. Nutzer melden das meist als „springt ans Ende der Seite".

**Ursache:** Next scrollt bei einer Client-seitigen Navigation das Fenster nach oben. Lenis führt aber **seine eigene** Scroll-Position und schreibt sie im nächsten Frame wieder ins DOM — die Navigation wird also überschrieben. Beim harten Reload gibt es das Problem nicht, weil Lenis neu bei 0 startet.

**Fix** — im Lenis-Provider auf `pathname` reagieren:

```tsx
// src/providers/LenisProvider.client.tsx
'use client'

import { ReactLenis, type LenisRef } from 'lenis/react'
import { usePathname } from 'next/navigation'
import React, { useEffect, useRef } from 'react'

export function LenisProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<LenisRef>(null)
  const pathname = usePathname()
  const isFirstRender = useRef(true)

  useEffect(() => {
    // Beim ersten Render nicht scrollen: sonst wird eine per URL angesprungene
    // Position (Deep Link, Browser-Restore) sofort wieder zerstört.
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    // Ein Hash ist der eine Fall, in dem die Position gewollt woanders liegt —
    // die macht der Anchor-Link (Abschnitt 5).
    if (window.location.hash) return

    ref.current?.lenis?.scrollTo(0, { immediate: true })
  }, [pathname])

  return (
    <ReactLenis root options={{ autoRaf: true, smoothWheel: true }} ref={ref}>
      {children}
    </ReactLenis>
  )
}
```

→ **`immediate: true` ist wichtig**, sonst sieht man die neue Seite eine halbe Sekunde lang nach oben fahren.

→ **Beide Guards braucht es wirklich.** Ohne `isFirstRender` verliert man Deep Links und die Scroll-Restaurierung beim Zurück-Button; ohne die Hash-Prüfung kämpft der Reset gegen den Anchor-Scroll und gewinnt.

## 2. `scrollIntoView({ behavior: 'smooth' })` tut nichts

**Symptom:** Ein „Weiter"-Button in einem mehrstufigen Formular soll zum nächsten Schritt scrollen — der Viewport bleibt stehen. Kein Fehler in der Konsole.

**Ursache:** Lenis besitzt den Seiten-Scroll und **schluckt natives Smooth-Scrolling**. `behavior: 'auto'` funktioniert, `behavior: 'smooth'` ist ein No-Op.

```tsx
// Falsch — unter Lenis wirkungslos:
containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

// Richtig — instant scrollen, Offset über scroll-margin-top:
containerRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
```

```tsx
// Der Container trägt den Abstand für den Sticky-Header (hier 128px):
<div ref={containerRef} className="scroll-mt-32">
```

→ Alternativ `lenis.scrollTo(el)` verwenden, wenn die Animation gewünscht ist. `scroll-mt-*` statt manueller Offset-Rechnung, weil derselbe Wert dann auch für native Hash-Sprünge und `:target` gilt.

→ **`scroll-behavior: smooth` in CSS** ist unter Lenis ebenfalls wirkungslos — und in `globals.css` gleichzeitig ein Konflikt. Weglassen.

## 3. Wheel über verschachtelten Scrollern scrollt die Seite

**Symptom:** Ein Dropdown/Listbox/Modal mit eigenem `overflow-y: auto` — das Mausrad scrollt die **Seite dahinter** statt der Liste.

**Ursache:** Root-Modus fängt das Wheel-Event global ab, bevor der innere Scroller es sieht. Lenis bietet dafür Data-Attribute; als Konstante einmal zentral ablegen, damit sie nicht an drei Stellen halb gesetzt werden:

```ts
// src/lib/lenis.ts
/** Markiert einen scrollbaren Overlay-Bereich, damit Lenis Wheel/Touch darin ignoriert. */
export const lenisPreventWheelProps = {
  'data-lenis-prevent': true,
  'data-lenis-prevent-touch': true,
  'data-lenis-prevent-wheel': true,
} as const
```

```tsx
<div className="max-h-80 overflow-y-auto" role="listbox" {...lenisPreventWheelProps}>
```

→ **Betrifft jede** eigengebaute Liste, Tabelle mit `overflow`, Code-Block und jedes scrollbare Modal. Fertige UI-Kits (shadcn/Radix Select) bringen die Opt-outs oft schon mit — Eigenbauten nie. Bei einem neuen Overlay-Element ist das der erste Punkt zum Prüfen.

## 4. Overlays: Lenis stoppen — aber nur einer darf ihn wieder starten

Solange ein Dialog offen ist, muss Lenis pausiert werden, sonst scrollt der Hintergrund unter dem Modal weg:

```tsx
const canResumeLenis = (root: HTMLElement) =>
  !root.hasAttribute('data-popup-open') && !root.hasAttribute('data-mobile-menu-open')

useEffect(() => {
  const root = document.documentElement
  const lenis = getLenisInstance()

  if (open) {
    root.setAttribute('data-popup-open', 'true')
    lenis?.stop()
  } else {
    root.removeAttribute('data-popup-open')
    if (canResumeLenis(root)) lenis?.start()   // ← der eigentliche Punkt
  }
}, [open])
```

→ **Der Bug, den man sonst erst spät bemerkt:** Sind zwei Overlays gleichzeitig offen (Mobile-Menü → Newsletter-Popup), startet das Schließen des einen Lenis wieder, obwohl das andere noch offen ist — der Hintergrund scrollt unter dem sichtbaren Overlay. Deshalb ein **Marker-Attribut pro Overlay-Typ am `<html>`** und ein Resume nur, wenn keiner mehr gesetzt ist. Ein simpler Zähler tut es auch; wichtig ist, dass `start()` nicht unbedingt vom Schließenden aufgerufen wird.

## 5. Anker-Links selbst übernehmen

Weil Lenis den Scroll besitzt, muss ein `#hash`-Link durch Lenis laufen. Kern des `AnchorSmoothLink`:

```tsx
const target = document.getElementById(decodeURIComponent(href.slice(1)))
if (!target) return
event.preventDefault()

const lenis = getLenisInstance()
if (lenis) {
  lenis.scrollTo(target, {
    duration: 0.8,
    force: true,                              // auch scrollen, wenn Lenis gestoppt ist
    offset: -resolveScrollMarginTop(target),  // Sticky-Header aus scroll-mt-* auslesen
    onComplete: () => focusAnchorTarget(target),
  })
  return
}
target.scrollIntoView({ behavior: 'smooth', block: 'start' })  // Fallback ohne Lenis
```

→ **Modifier-Klicks vorher durchlassen** (`metaKey`, `ctrlKey`, `shiftKey`, `altKey`, `button !== 0`, `target="_blank"`), sonst bricht „in neuem Tab öffnen".

→ **`offset` aus `scroll-margin-top` des Ziels lesen**, statt die Header-Höhe im Link zu hardcoden — sonst pflegt man denselben Wert an zehn Stellen.

→ **Fokus nachziehen** (Barrierefreiheit, vgl. [`accessibility/`](../accessibility/description.md)): Ein per JS ausgeführter Scroll bewegt den Tastatur-Fokus nicht mit. Also `tabindex="-1"` setzen und `focus({ preventScroll: true })` — sonst tabbt ein Nutzer nach dem Sprung weiter oben auf der Seite weiter.

## 6. Bonus: Firefox scrollt fünf- bis zehnmal zu langsam

Firefox ist der einzige große Browser, der Wheel-Deltas noch **in Zeilen** meldet (`deltaMode !== 0`). Lenis rechnet eine Zeile mit 100/6 ≈ 16,7 px — plausibel für eine Textzeile, aber weit unter den 100 px+, die eine Rastung sonst bewegt.

```tsx
<ReactLenis
  root
  options={{
    autoRaf: true,
    smoothWheel: true,
    // Läuft NACH der Zeilen-zu-Pixel-Umrechnung von Lenis, skaliert also den
    // bereits normalisierten Wert.
    virtualScroll: (data) => {
      if (data.event instanceof WheelEvent && data.event.deltaMode !== 0) {
        data.deltaX *= 3
        data.deltaY *= 3
      }
      return true
    },
  }}
  ref={ref}
/>
```

→ Der Faktor ist **nach Gefühl gesetzt** — der Browser verrät nicht, wie weit er eine Rastung gedacht hat. Gegen ein echtes Firefox gegenprüfen und ggf. anpassen.

## 7. Zugriff auf die Instanz ohne Prop-Drilling

Anchor-Links, Dialoge und Formular-Schritte brauchen alle dieselbe Instanz. Statt Context durch den halben Baum zu reichen, ein schmales Singleton mit genau den drei benötigten Methoden:

```ts
// src/lib/lenis.ts
let lenisInstance: LenisInstance | null = null
export const setLenisInstance = (i: LenisInstance | null) => { lenisInstance = i }
export const getLenisInstance = () => lenisInstance
```

```tsx
useEffect(() => {
  const instance = ref.current?.lenis
  if (!instance) return

  setLenisInstance({
    scrollTo: (t, o) => instance.scrollTo(t, o),
    start: () => instance.start(),
    stop: () => instance.stop(),
  })

  return () => {
    setLenisInstance(null)   // ← beim Unmount zurücksetzen
    instance.destroy()
  }
}, [])
```

→ **`setLenisInstance(null)` im Cleanup nicht vergessen**, sonst hält das Modul im Dev-Modus (Fast Refresh, doppelte Effects) eine tote Instanz fest, und `scrollTo` läuft ins Leere.

→ Die Konsumenten müssen mit `null` umgehen können (`getLenisInstance()?.stop()`), weil sie vor dem Provider-Effect rendern können.

## 8. `prefers-reduced-motion`

Lenis ignoriert `scroll-behavior: auto` aus der Reduced-Motion-Media-Query — die muss man selbst auswerten:

```ts
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (reduce) lenis.destroy()
```

Details und der Rest der Regel in [`accessibility/`](../accessibility/description.md).

## Quick-Checkliste

1. Provider setzt bei `pathname`-Wechsel `scrollTo(0, { immediate: true })` — mit First-Render- **und** Hash-Guard
2. Kein `behavior: 'smooth'` und kein `scroll-behavior: smooth` in CSS; stattdessen `'auto'` + `scroll-mt-*` oder `lenis.scrollTo`
3. Jeder verschachtelte Scroller bekommt `lenisPreventWheelProps`
4. Overlays: `stop()` beim Öffnen, `start()` nur wenn **kein** anderes Overlay-Marker-Attribut mehr am `<html>` hängt
5. Anker-Links über `lenis.scrollTo` mit `force: true`, Offset aus `scroll-margin-top`, Modifier-Klicks durchlassen, Fokus nachziehen
6. Firefox gegenprüfen (`deltaMode !== 0`) — sonst kriecht das Scrolling dort
7. Singleton im Cleanup auf `null` setzen; Konsumenten optional-chainen
8. `prefers-reduced-motion` → Lenis gar nicht erst starten
