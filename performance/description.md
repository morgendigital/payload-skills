# Next.js Performance — Cheat Sheet

Praktische Schritte, um Bundle-Größe, Build- und Render-Zeit in einem Next.js-/Payload-Projekt zu senken. Reihenfolge der Quick-Checkliste steht am Ende.

## 1. Bundle Analyzer einbauen

Damit du siehst, was deine Bundles groß macht.

**Install:**

```bash
pnpm add -D @next/bundle-analyzer
```

**`next.config.js`:**

```js
import bundleAnalyzer from '@next/bundle-analyzer'

const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === 'true' })

// ... am Ende deine Config wrappen:
export default withBundleAnalyzer(nextConfig)
```

**`package.json` Script:**

```json
"analyze": "cross-env ANALYZE=true next build"
```

→ `pnpm analyze` öffnet die interaktiven Treemaps.

## 2. `serverExternalPackages` — schwere Server-Only-Pakete aus dem Bundle halten

Pakete, die nur serverseitig laufen, werden nicht mitgebundlet (kein Webpack-Processing, schnellerer Build, kleineres Server-Bundle).

```js
const nextConfig = {
  serverExternalPackages: [
    'payload',
    '@payloadcms/db-mongodb',
    'sharp',
    'three',
    'matter-js',
    'ical.js',
  ],
}
```

→ Pro Projekt anpassen: alles reinpacken, was nur auf dem Server läuft und nativ/groß ist (DB-Adapter, Image-Processing, 3D-Libs, Parser).

## 3. `optimizePackageImports` — Tree-Shaking für Barrel-Exports

Verhindert, dass beim Import eines einzelnen Icons/Helpers die ganze Library geladen wird.

```js
experimental: {
  cssChunking: true,
  optimizePackageImports: [
    '@mui/material',
    '@mui/icons-material',
    'lucide-react',
    'lodash',
    'motion',
  ],
}
```

→ Faustregel: jede Library mit großem Barrel-Index (Icons, UI-Kits, lodash, date-fns, motion) hier eintragen.

## 4. `dynamic()` Imports — Code-Splitting für schwere/seltene Komponenten

Komponenten, die nicht auf jeder Seite gebraucht werden oder schwere Deps ziehen, lazy laden. Muster aus `src/blocks/RenderBlocks.tsx`:

```tsx
import dynamic from 'next/dynamic'

// Named export → default mappen:
const PortfolioBlock = dynamic(() =>
  import('@/blocks/Portfolio/Component').then((m) => ({ default: m.PortfolioBlock })),
)

// Client-only Libs (z.B. Lottie) ohne SSR:
const Lottie = dynamic(() => import('lottie-react'), { ssr: false })
```

**Kandidaten:** Lottie/Animationen, Slider, 3D/Canvas, Code-Highlighting, Charts, alles „below the fold" oder selten gerendert. Den `type`-Import behalten (`import type { ... }`), damit TS happy bleibt.

→ In diesem Projekt dynamisch gemacht: `PortfolioBlock`, `PortfolioGridBlock`, `DevScreenTextBlock`, `DevPlaygroundBlock`, `ImageSliderBlock`, `LottieMedia`, `DotLottieMedia`, `CodeBlock`, `Logo` (Lottie).

## 5. ISR — `revalidate` auf Seiten setzen

Statisch generieren + im Hintergrund neu validieren statt bei jedem Request rendern. In `src/app/(frontend)/[locale]/[slug]/page.tsx`:

```ts
export const revalidate = 60 // Sekunden
```

Kombiniert mit `generateStaticParams()` für vorab gebaute Pfade.

## 6. `images.minimumCacheTTL` für Images

Next.js Image-Optimizer cached optimierte Bilder länger (weniger Re-Processing). **Wichtig:** Die Option liegt unter `images`, **nicht** auf der obersten `nextConfig`-Ebene.

```js
const nextConfig = {
  images: {
    minimumCacheTTL: 86400, // 24h
  },
}
```

- Seit **Next.js 16** ist der Default `14400` (4h); davor waren es 60 s. Für das alte Verhalten explizit `minimumCacheTTL: 60` setzen.
- Die TTL ist das Maximum aus `minimumCacheTTL` und dem `Cache-Control`-Header des Ursprungsbildes.
- Es gibt keinen Invalidierungs-Mechanismus für den optimierten Cache — sehr hohe Werte mit Bedacht wählen.

## 7. Daten-Fetching: parallelisieren & cachen

Aus dem Calendar/Page-Refactor (`page.tsx`):

**Sequentielle `await`s → `Promise.all` wenn unabhängig:**

```ts
const [landingPageResult, devPageResult] = await Promise.all([
  payload.find({ collection: 'landingpages', ...baseQuery }),
  payload.find({ collection: 'dev-pages', ...baseQuery }),
])
```

- React `cache()` um teure Queries pro Request zu dedupen.
- DB Timeouts setzen (`payload.config.ts`), damit hängende Connections nicht den ganzen Render blockieren:

```ts
connectOptions: { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 20000 }
```

## 8. On-Demand Revalidation — Cache nach Mutationen gezielt invalidieren

Statt nur auf den Zeit-`revalidate` (Abschnitt 5) zu warten: Cache nach einer Änderung (z.B. Payload-Hook, Server Action) sofort neu validieren.

```ts
'use server'
import { revalidateTag, revalidatePath } from 'next/cache'

export async function onPostChange() {
  revalidateTag('posts', 'max') // alle mit Tag 'posts' markierten Daten
  revalidatePath('/blog')       // oder einen konkreten Pfad
}
```

`fetch`-Requests dazu taggen, damit `revalidateTag` greift:

```ts
const data = await fetch('https://...', { next: { tags: ['posts'] } })
```

→ **Achtung:** Die Einzel-Argument-Form `revalidateTag('posts')` ist deprecated; neu mit Profil: `revalidateTag('posts', 'max')` (stale-while-revalidate). In Payload bietet sich ein `afterChange`-Hook auf der Collection an, der die passenden Tags/Pfade revalidiert.

## 9. `unstable_cache` — DB-Queries cachen (ohne `fetch`)

`cache()` dedupliziert nur pro Request. `unstable_cache` cached ORM-/DB-Queries **über Requests hinweg** — mit Tags für On-Demand-Revalidation und eigener TTL.

```ts
import { unstable_cache } from 'next/cache'

const getCachedPosts = unstable_cache(
  async () => payload.find({ collection: 'posts' }),
  ['posts'],                          // Cache-Key-Prefix
  { revalidate: 3600, tags: ['posts'] },
)
```

→ Spielt direkt mit `revalidateTag('posts', 'max')` aus Abschnitt 8 zusammen.

## 10. Streaming mit `<Suspense>` / `loading.tsx`

Langsame Komponenten streamen, statt die ganze Seite auf die langsamste Query warten zu lassen. Statische Shell kommt sofort, Daten trudeln nach.

```tsx
import { Suspense } from 'react'

export default function Page() {
  return (
    <>
      <Header /> {/* statisch, sofort sichtbar */}
      <Suspense fallback={<RevenueSkeleton />}>
        <Revenue /> {/* langsame Query, streamt nach */}
      </Suspense>
    </>
  )
}
```

→ `loading.tsx` im Route-Ordner ist die einfachste Variante (wrapt die ganze Page automatisch in Suspense). Mehrere unabhängige Bereiche → je eigene `<Suspense>`-Grenze. **Wichtig fürs LCP:** das LCP-Element (z.B. Hero) **außerhalb** der Suspense-Grenze halten, damit es in der statischen Shell rendert.

## 11. `next/image` — LCP-Bild bevorzugt laden

Das wichtigste Above-the-fold-Bild (Hero/LCP) sollte nicht lazy geladen werden:

```tsx
<Image src="/hero.jpg" alt="" width={1200} height={600} priority sizes="100vw" />
```

- `priority` → deaktiviert Lazy-Loading und preloaded das Bild (für das LCP-Element). _Hinweis: in neueren Next.js-Versionen kommt `preload` als Nachfolger-Prop._
- `sizes` korrekt setzen, damit der Optimizer nicht unnötig große Varianten ausliefert.
- Alle anderen Bilder: Default (lazy) lassen.

## 12. Build-Speed: Turbopack Filesystem Cache (experimental)

Persistenter Cache für schnellere Dev- und Production-Builds:

```ts
experimental: {
  turbopackFileSystemCacheForDev: true,   // stabil für `next dev`
  turbopackFileSystemCacheForBuild: true, // experimentell für `next build`
}
```

→ Für `next dev` weitgehend stabil; für `next build` noch experimentell — vor Produktivnutzung testen.

## Quick-Checkliste für ein neues Projekt

1. `@next/bundle-analyzer` + `analyze` Script → einmal laufen lassen, größte Brocken finden
2. Schwere Server-Libs → `serverExternalPackages`
3. Icon-/Util-Libs → `optimizePackageImports`
4. Größte Client-Komponenten aus dem Analyzer → `dynamic()` (Lottie/Canvas/Slider mit `ssr: false`)
5. CMS-/Content-Seiten → `export const revalidate` + `generateStaticParams`
6. `images.minimumCacheTTL` für Images; LCP-Bild mit `priority` + `sizes`
7. Unabhängige `await`s → `Promise.all`, teure Queries in `cache()` / `unstable_cache()`, DB-Timeouts
8. Mutationen (Payload-Hooks/Server Actions) → `revalidateTag` / `revalidatePath` + getaggte `fetch`s
9. Langsame Page-Teile → `<Suspense>` / `loading.tsx`, LCP-Element außerhalb der Suspense-Grenze
10. Optional Build-Speed → `turbopackFileSystemCache*` (für `next build` noch experimentell)
