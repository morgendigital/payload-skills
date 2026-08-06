# Static Rendering (SSG) mit Payload + Next.js auf Dokploy

> **Korrigiert Todo 3 aus [payload-start](../payload-start/description.md).** Der dort beschriebene
> zweistufige Build (`--experimental-build-mode generate-env` → `compile`) ist ein
> **Build-ohne-Datenbank**-Modus. Er überspringt das Prerendering *und* schaltet den Route-Cache
> komplett ab. Wer ihn einsetzt, rendert jede einzelne Anfrage live aus Mongo — auch wenn im Code
> `export const revalidate = …` steht.

Alle Zahlen unten sind an northlight.at gemessen (Next.js 15.5, Payload 3.78, Dokploy/Hetzner,
`next start`, jeweils frisch gebaut).

## Warum das wichtig ist

Dieselbe Seite (`/agency`), drei Build-Varianten:

| Build | erste Anfrage | Folgeanfragen |
| ----- | ------------- | ------------- |
| `generate-env` → `compile` (zweistufig) | ~330 ms, kein Cache-Header | ~330 ms, **kein Cache** |
| voller `next build` **ohne** DB (leere `generateStaticParams`) | ~260 ms | ~260 ms, **kein Cache** (Details in Regel 3) |
| voller `next build` **mit** DB (echtes SSG) | **11 ms**, `x-nextjs-cache: HIT` | **5 ms**, HIT |

Im zweistufigen Build ist `prerender-manifest.json` leer, alle Routen stehen als `ƒ (Dynamic)` im
Build-Output, und die Antwort trägt `Cache-Control: private, no-cache, no-store, must-revalidate`.
Es gibt dort keinen Cache, den man mit einem Warmup-Skript füllen könnte.

## Regel 1 — voller `next build`, mit DB-Zugriff beim Bauen

```json
"build": "node scripts/build.mjs",
"build:no-db": "cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode generate-env && cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode compile",
```

Der zweistufige Build bleibt als **Notausgang** stehen (Deploy möglich, wenn die DB beim Bauen
partout nicht erreichbar ist) — mit dem Wissen, dass die Seite dann ungecacht läuft.

Schlägt der Build fehl, weil die DB fehlt, behält Dokploy den laufenden Container. Das Risiko ist
also ein fehlgeschlagenes Deployment, keine kaputte Seite.

### Wenn Build-Server und DB-Server auseinanderfallen

Dokploy gibt Nixpacks **denselben** Variablensatz für Build und Laufzeit. Braucht der Build eine
andere Adresse als der laufende Container (z. B. Tailscale beim Builder, interne Adresse zur
Laufzeit), löst das ein Wrapper:

```js
// scripts/build.mjs
import { spawnSync } from 'node:child_process'

const nodeOptions = [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ')
const env = { ...process.env, NODE_OPTIONS: nodeOptions }

if (process.env.DATABASE_URI_BUILD) {
  env.DATABASE_URI = process.env.DATABASE_URI_BUILD
  console.log('[build] using DATABASE_URI_BUILD for this build')
}

const result = spawnSync('next', ['build'], { stdio: 'inherit', env })
process.exit(result.status ?? 1)
```

In Dokploy dann `DATABASE_URI` = Laufzeit-Adresse, `DATABASE_URI_BUILD` = Build-Adresse.

### Was eingebacken wird und was nicht

| | im Build-Output? |
| --- | --- |
| `DATABASE_URI` | **nein** — bleibt `process.env.DATABASE_URI` im Server-Bundle, darf sich zwischen Build und Laufzeit unterscheiden |
| `NEXT_PUBLIC_SERVER_URL` | **ja** — landet in `canonical` und `og:url` **jeder** prerenderten Seite |
| serverseitig gelesene Feature-Flags | **ja** — eine Änderung wirkt erst nach Redeploy oder Revalidierung |
| Media-URLs (bei `disableLocalStorage` + privatem S3) | relativ (`/api/media/file/…`), S3-Variablen beim Build daher egal |

Ein Build mit falscher `NEXT_PUBLIC_SERVER_URL` produziert stillschweigend eine Seite, deren
Canonicals auf `localhost:3000` zeigen. Nach dem ersten Produktions-Build gegenprüfen:

```bash
grep -c "localhost:3000" .next/server/app/de/*.html
```

## Regel 2 — `generateStaticParams` muss **alle** dynamischen Segmente liefern

Der Klassiker im `[locale]/[slug]`-Aufbau: Die Blatt-Seite gibt nur `{ slug }` zurück, das
Elternsegment `[locale]` hat kein eigenes `generateStaticParams`. Next kann daraus keinen konkreten
Pfad bilden und fällt **still** auf On-Demand-Rendering zurück — **kein Fehler, keine Warnung**. Im
Build-Output steht die Route trotzdem als `● (SSG)` da, nur eben ohne einen einzigen Pfad darunter.

```ts
// src/utilities/locales.ts
export const LOCALES = ['de', 'en'] as const

export const withLocales = <T extends Record<string, unknown>>(params: T[]) =>
  LOCALES.flatMap((locale) => params.map((param) => ({ ...param, locale })))
```

```ts
export async function generateStaticParams() {
  const pages = await payload.find({ collection: 'pages', /* … */ })

  return withLocales(pages.docs.map(({ slug }) => ({ slug })))
}
```

Routen ohne eigene Params (Startseite, hartkodierte Funnels) brauchen ein eigenes
`generateStaticParams`, das nur die Locales liefert. Achtung bei Re-Exports: Segment-Config
(`revalidate`, `generateStaticParams`) wird **nicht** mitvererbt, wenn eine Page eine andere
re-exportiert — sie muss in jeder Datei stehen.

**Verifizieren statt hoffen** — der Build-Output allein reicht nicht:

```bash
node -e "const m=require('./.next/prerender-manifest.json'); console.log(Object.keys(m.routes).length)"
find .next/server/app -name '*.html' | wc -l
```

## Regel 3 — Middleware-Rewrites nehmen Laufzeit-Renders aus dem Cache

Der übliche Locale-Aufbau versteckt die Default-Locale per Rewrite:

```ts
// src/middleware.ts
if (!locales.includes(firstSegment)) {
  return NextResponse.rewrite(new URL(`/${defaultLocale}${pathname}`, request.url))
}
```

Eine Antwort, die **zur Laufzeit** hinter so einem `rewrite()` gerendert wird, fällt aus dem Full
Route Cache heraus. Gemessen an einem Build, dessen Routen sauber als ISR registriert waren:

```
/en/agency   (kein Rewrite)   MISS 309 ms  →  HIT 6 ms
/agency      (Rewrite → /de)  kein Cache, ~260 ms bei jeder Anfrage
```

Also ausgerechnet die Default-Locale — der Großteil des Traffics — läuft ungecacht.

**Prerendertes HTML ist davon nicht betroffen**, weil es gar nicht gerendert, sondern direkt aus dem
Build-Output ausgeliefert wird (`/agency` → HIT in 11 ms schon beim ersten Abruf).

Daraus folgt die harte Konsequenz: **Bei einem Default-Locale-Rewrite ist Build-Time-SSG Pflicht.**
Auf ISR als Fallback zu setzen („die erste Anfrage wärmt den Cache") funktioniert für die
Default-Locale nicht — und ein Warmup-Skript nach dem Deploy ändert daran nichts.

## Regel 4 — `revalidatePath` braucht den **internen** Pfad

Die Payload-Hooks aus dem Website-Template revalidieren `/${doc.slug}`. Sobald die Routen unter
`[locale]` liegen, ist der interne Pfad aber `/de/slug` — der Aufruf geht ins Leere. Solange
`revalidate` kurz gesetzt ist, kaschiert der Timer den Fehler; mit echtem SSG und langem Intervall
bleibt die Seite stehen.

```ts
export const localePaths = (path: string) => {
  const suffix = path === '/' ? '' : path.startsWith('/') ? path : `/${path}`
  return LOCALES.map((locale) => `/${locale}${suffix}`)
}
```

Beim Umbau mit prüfen:

- **Pfade, die es gar nicht gibt.** Landingpages, die über `[locale]/[slug]` ausgeliefert werden,
  aber als `/landing/${slug}` revalidiert werden.
- **Locale-gescopte Cache-Tags.** `getCachedGlobal('header', 1, locale)` schreibt
  `global_header_de` / `global_header_en` — ein `revalidateTag('global_header')` trifft nichts.
- **Globals in Layouts.** Header und Footer stecken im prerenderten HTML jeder Seite. Ein Tag-Drop
  allein reicht nicht, es braucht zusätzlich `revalidatePath('/[locale]', 'layout')`.
- **Zu grobe Purges.** `revalidatePath('/', 'layout')` bei jedem Doc-Save wirft die komplette
  statische Auslieferung weg — gezielte Pfade nehmen.

## Regel 5 — Prerender-Blocker außerhalb der Locale-Routen finden

Jede statische Route ohne Params wird beim Build gerendert. Zieht ihr Layout ein Payload-Global
(typisch: ein `<Footer/>` in einem Sonder-Layout), braucht der Build dafür eine DB-Verbindung. Mit
Regel 1 ist das kein Problem — nur beim Notausgang-Build fliegt es als
`Error occurred prerendering page` um die Ohren.

## Checkliste für ein neues Projekt

1. `build`-Script auf vollen `next build` (Wrapper, falls Build- und Laufzeit-DB-Adresse abweichen).
2. `generateStaticParams` liefert **alle** dynamischen Segmente, inklusive Locale — auch auf
   Startseite und hartkodierten Routen.
3. `revalidate` als Sicherheitsnetz (z. B. 3600), Aktualität kommt über die Payload-Hooks.
4. Revalidierungs-Hooks auf interne Pfade + locale-gescopte Tags umstellen, Layout-Globals extra.
5. Build-Env vollständig: `DATABASE_URI(_BUILD)`, `PAYLOAD_SECRET`, `NEXT_PUBLIC_SERVER_URL` =
   Produktions-URL, Tracking-IDs.
6. Nach dem ersten Deploy verifizieren:

```bash
curl -sI https://example.com/eine-seite | grep -i x-nextjs-cache   # → HIT
```

7. Bei mehr als einer Replica: `revalidatePath` erreicht nur die Instanz, die den Payload-Request
   bearbeitet hat. Entweder eine Instanz fahren oder einen gemeinsamen Cache-Handler einrichten.
