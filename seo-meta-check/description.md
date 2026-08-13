# SEO- & Meta-Check — Defaults überschreiben + Admin-Dashboard (Payload + Next.js)

Zwei Themen, die im Alltag zusammengehören:

1. **Die Meta-Fallback-Kette korrekt bauen** — Seiten-Meta muss die Site-Defaults **überschreiben** (Titel, Description **und OG-Bild**), leere Seiten-Werte dürfen die Defaults umgekehrt **nicht** zerstören. Im Payload-Website-Template ist beides kaputt.
2. **Ein Admin-Dashboard**, das den Meta-Status **über alle Seiten** auf einen Blick zeigt: was gepflegt ist, wo Titel/Description/Bild fehlen oder doppelt sind.

> Abgrenzung: [`seo/description.md`](../seo/description.md) behandelt die Onpage-Grundlagen (Titel-Fallback, Canonical, Sitemap, `Media.alt`). Dieser Skill setzt darauf auf und behandelt **Default-Überschreibung** und **Redaktions-Kontrolle**.

## 0. Gibt es dafür schon ein Community-Plugin?

Kurz: für die Felder ja, für das Dashboard nur bedingt.

| Paket | Was es kann | Einschätzung |
| --- | --- | --- |
| [`@payloadcms/plugin-seo`](https://payloadcms.com/docs/plugins/seo) | Offiziell. Liefert die `meta`-Feldgruppe (title/description/image), Zeichenzähler, Suchergebnis-Preview, „Auto-generieren"-Button. | **Immer nutzen** — aber es macht **keinen** Site-weiten Check und füllt nichts automatisch (siehe [`seo/description.md`](../seo/description.md)). |
| [`@consilioweb/payload-seo-analyzer`](https://www.npmjs.com/package/@consilioweb/payload-seo-analyzer) (`github.com/pOwn3d/payload-seo-analyzer`, MIT) | Genau die gesuchte Richtung: 50+ Onpage-Checks in der Editor-Sidebar, **9-View-Admin-Dashboard** unter `/admin/seo` (Site-weites Audit, Link-Graph, Redirect-Manager, Schema-Builder), Score-Historie, GSC-Anbindung, optionale AI-Assists. | **Prüfen, aber nicht blind einsetzen** — siehe Caveats unten. |
| [`@payloadcms/plugin-redirects`](https://payloadcms.com/docs/plugins/redirects) | Redirects redaktionell pflegbar. | Ergänzend sinnvoll, löst aber ein anderes Problem. |

**Caveats zum SEO-Analyzer** (Stand npm 1.22.0, Aug 2026):

- **Sehr geringe Verbreitung** (~350 Downloads/Woche, Ein-Personen-Projekt). Für Kundenprojekte heißt das: Update-Risiko bei jedem Payload-Minor.
- **RBAC failt open** — der Admin-Gate ist standardmäßig permissiv; in Produktion **`SEO_REQUIRE_ADMIN_ROLE=1`** setzen, sonst sind die `/api/seo-plugin/*`-Endpoints zu weit offen. Zusätzlich `SEO_GSC_ENCRYPTION_KEY` setzen, wenn GSC genutzt wird.
- **Ressourcenhungrig auf kleinen Hosts** — das Site-weite Audit läuft im Hintergrund über alle Dokumente. Auf Hetzner/Dokploy-Instanzen mit wenig RAM über `SEO_AUDIT_BATCH_DELAY_MS`, `SEO_AUDIT_DEPTH=0`, `SEO_FETCH_MAX_DOCS` drosseln (vgl. [`performance/`](../performance/description.md)).
- **Defaults sind FR-first** (`locale: 'fr'`), AI-Features brauchen einen eigenen `ANTHROPIC_API_KEY`.
- Bringt eigene `buildSeoMetadata()`-Helper mit, die mit der eigenen `generateMeta.ts` kollidieren — **eins von beidem**, nicht beides.

**Empfehlung:** Für den typischen Projektumfang (Pages + Posts, 20–200 Dokumente) reicht die ~200 Zeilen eigene Dashboard-View aus Abschnitt 5 — kein Abhängigkeitsrisiko, exakt die Regeln, die man will, und sie läuft auf demselben Datenbestand wie `generateMeta`. Den Analyzer nur ziehen, wenn Link-Graph, GSC-Integration und Score-Historie wirklich gebraucht werden.

## 1. Der Bug: das Website-Template überschreibt die Defaults nicht

`src/utilities/mergeOpenGraph.ts` aus dem offiziellen Template:

```ts
export const mergeOpenGraph = (og?: Metadata['openGraph']): Metadata['openGraph'] => {
  return {
    ...defaultOpenGraph,
    ...og,                                          // ← leere Strings gewinnen
    images: og?.images ? og.images : defaultOpenGraph.images,
  }
}
```

und `generateMeta.ts` ruft es so auf:

```ts
openGraph: mergeOpenGraph({
  description: doc?.meta?.description || '',        // ← '' wenn ungepflegt
  images: ogImage ? [{ url: ogImage }] : undefined, // ← ogImage ist IMMER truthy
  title,
  url: Array.isArray(doc?.slug) ? doc?.slug.join('/') : '/',
})
```

Daraus folgen drei Fehler:

- **Leere Werte zerstören die Defaults.** `description: ''` gewinnt im Spread gegen die Site-Description → Seiten ohne gepflegte Description bekommen `og:description=""` statt des Defaults. Object-Spread unterscheidet nicht zwischen „leer" und „nicht gesetzt".
- **Das Default-Bild wird nie ersetzt — und ist gleichzeitig immer gesetzt.** `getImageURL()` gibt bei nicht-populiertem `meta.image` **die Template-Datei** `/website-template-OG.webp` zurück. Die liegt in echten Projekten nicht in `public/` → **jede** Seite bekommt ein `og:image`, das 404 liefert. Und weil `images` dadurch nie `undefined` ist, greift der `og?.images ? ...`-Zweig immer.
- **Das Seiten-Bild greift nur bei ausreichender `depth`.** `getImageURL` prüft `typeof image === 'object'`. Wird die Seite mit `depth: 0` oder mit `select` ohne `meta.image` geladen, ist `meta.image` nur die ID → stillschweigend Default-Bild, obwohl die Redaktion ein Bild gepflegt hat. **Das ist die häufigste Ursache für „mein OG-Bild kommt nicht an".**

## 2. Fix: `mergeOpenGraph` mit echter Fallback-Semantik

Leere Werte rauswerfen, statt sie zu spreaden:

```ts
// src/utilities/mergeOpenGraph.ts
import type { Metadata } from 'next'
import { getServerSideURL } from './getURL'

const defaultOpenGraph: Metadata['openGraph'] = {
  type: 'website',
  locale: 'de_DE',
  siteName: 'Marke',
  title: 'Marke',
  description: 'Site-weiter Default-Text.',
  images: [{ url: `${getServerSideURL()}/og-default.jpg`, width: 1200, height: 630, alt: 'Marke' }],
}

/** Entfernt undefined/null/'' und leere Arrays — nur echte Werte überschreiben die Defaults. */
const definedOnly = <T extends object>(obj?: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>

export const mergeOpenGraph = (og?: Metadata['openGraph']): Metadata['openGraph'] => ({
  ...defaultOpenGraph,
  ...definedOnly(og),
})
```

→ Die `images`-Sonderbehandlung entfällt: `images` landet nur im Spread, wenn es ein nicht-leeres Array ist. **Seiten-Bild gewinnt, fehlendes Seiten-Bild fällt auf den Default zurück** — beides ohne Sonderfall.

→ **Default-Bild in `public/og-default.jpg` ablegen** (1200×630, JPG/PNG — kein WebP, X/LinkedIn rendern es unzuverlässig, und kein SVG). Der Pfad aus dem Template (`/website-template-OG.webp`) existiert im eigenen Projekt nicht.

## 3. Fix: das OG-Bild der Seite sauber auflösen

```ts
// src/utilities/generateMeta.ts
import type { Media, Page, Post } from '@/payload-types'
import { getMediaUrl } from './getMediaUrl'

type OgImage = NonNullable<Metadata['openGraph']>['images']

const resolveOgImage = (image: Page['meta']['image']): OgImage | undefined => {
  // Nicht populiert (ID/String) → KEIN Fallback-Bild hier erfinden,
  // das macht mergeOpenGraph. Aber im Dev laut sein, sonst sucht man ewig.
  if (image && typeof image !== 'object') {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[seo] meta.image nicht populiert — depth der Query erhöhen (>= 1)')
    }
    return undefined
  }
  if (!image) return undefined

  const media = image as Media
  const size = media.sizes?.og
  const url = size?.url ?? media.url
  if (!url) return undefined

  return [
    {
      url: getMediaUrl(url),               // absolut machen, S3/imgproxy-sicher
      width: size?.width ?? media.width ?? undefined,
      height: size?.height ?? media.height ?? undefined,
      alt: media.alt ?? undefined,
    },
  ]
}

export const generateMeta = async (args: {
  doc: Partial<Page> | Partial<Post> | null
  path?: string
}): Promise<Metadata> => {
  const { doc } = args

  const slugPath = doc?.slug ? `/${Array.isArray(doc.slug) ? doc.slug.join('/') : doc.slug}` : '/'
  const path = args.path ?? (slugPath === '/home' ? '/' : slugPath)

  const titleBase = doc?.meta?.title || doc?.title          // Fallback: siehe seo/description.md
  const title = titleBase ? `${titleBase} | Marke` : 'Marke'
  const description = doc?.meta?.description || undefined   // '' → undefined, damit Default greift
  const images = resolveOgImage(doc?.meta?.image)

  return {
    title,
    description,
    alternates: { canonical: `${getServerSideURL()}${path}` },
    robots: doc?.meta?.noIndex ? { index: false, follow: false } : undefined,
    openGraph: mergeOpenGraph({ title, description, images, url: path }),
    twitter: { card: 'summary_large_image', title, description, images },
  }
}
```

→ **`getMediaUrl` statt String-Konkatenation.** Das Template baut `serverUrl + image.url`. Mit `@payloadcms/storage-s3` ist `image.url` bereits absolut → `https://site.dehttps://s3…`. Siehe [`image-optimization/`](../image-optimization/description.md).

→ **`og`-Bildgröße in der Media-Collection anlegen**, sonst wird das Originalbild (oft 4 MB) als OG-Bild ausgeliefert:

```ts
// src/collections/Media.ts
upload: {
  imageSizes: [
    // …
    { name: 'og', width: 1200, height: 630, crop: 'center', withoutEnlargement: false },
  ],
}
```

→ **`depth` der Seiten-Query prüfen.** Alle Routen, die `generateMeta` füttern, brauchen `depth >= 1`. Wer aus Performance-Gründen `select` nutzt, muss `meta` mitselektieren:

```ts
const result = await payload.find({
  collection: 'pages',
  depth: 1,
  where: { slug: { equals: slug } },
  select: { title: true, slug: true, meta: true, layout: true },
})
```

→ **`twitter` explizit setzen.** Next.js leitet die `twitter`-Tags **nicht** aus `openGraph` ab. Im Template steht nur `card` + `creator` im Root-Layout; Seiten-Metadaten ersetzen ein Objekt außerdem **komplett** statt es zu mergen — deshalb `title`/`description`/`images` pro Seite mitgeben.

## 4. Optional: Defaults redaktionell pflegbar machen

Wenn die Redaktion Default-Titel/-Description/-Bild selbst ändern soll, statt Konstanten im Code:

```ts
// src/globals/SeoDefaults.ts
export const SeoDefaults: GlobalConfig = {
  slug: 'seo-defaults',
  admin: { group: 'SEO' },
  access: { read: () => true },
  fields: [
    { name: 'siteName', type: 'text', required: true },
    { name: 'description', type: 'textarea', required: true, maxLength: 160 },
    { name: 'image', type: 'upload', relationTo: 'media', required: true,
      admin: { description: 'Fallback-OG-Bild, 1200×630' } },
  ],
}
```

und in `generateMeta` über den gecachten Global-Getter des Templates lesen:

```ts
import { getCachedGlobal } from '@/utilities/getGlobals'

const defaults = await getCachedGlobal('seo-defaults', 1)()
```

→ `mergeOpenGraph` bekommt die Defaults dann als zweites Argument statt aus der Modul-Konstante. **`getCachedGlobal` benutzen, nicht `payload.findGlobal` direkt** — sonst ein DB-Query pro Seitenaufruf.

## 5. Dashboard: Meta-Check über alle Seiten

Eine eigene Admin-View unter `/admin/seo-check` plus ein Kachel-Widget auf dem Dashboard. Keine zusätzliche Dependency.

### 5.1 Regeln (`checks.ts`)

```ts
// src/components/SeoCheck/checks.ts
import type { CollectionSlug } from 'payload'

export type Severity = 'ok' | 'warn' | 'error'
export type Finding = { label: string; severity: Severity }

export type SeoRow = {
  id: number | string
  collection: CollectionSlug
  title: string
  path: string
  status: Severity
  findings: Finding[]
}

export type MetaDoc = {
  id: number | string
  title?: null | string
  slug?: null | string
  _status?: 'draft' | 'published' | null
  meta?: {
    title?: null | string
    description?: null | string
    image?: unknown
    noIndex?: boolean | null
  } | null
}

export const LIMITS = { TITLE_MIN: 30, TITLE_MAX: 60, DESC_MIN: 70, DESC_MAX: 160 }

const norm = (v?: null | string) => (v ?? '').trim().toLowerCase()
const worst = (f: Finding[]): Severity =>
  f.some((x) => x.severity === 'error') ? 'error' : f.some((x) => x.severity === 'warn') ? 'warn' : 'ok'

export const buildRows = (
  input: { collection: CollectionSlug; doc: MetaDoc; path: string }[],
): SeoRow[] => {
  // Duplikate site-weit zählen — der Grund, warum der Check ALLE Dokumente auf einmal braucht.
  const titles = new Map<string, number>()
  const descs = new Map<string, number>()
  for (const { doc } of input) {
    const t = norm(doc.meta?.title || doc.title)
    const d = norm(doc.meta?.description)
    if (t) titles.set(t, (titles.get(t) ?? 0) + 1)
    if (d) descs.set(d, (descs.get(d) ?? 0) + 1)
  }

  return input.map(({ collection, doc, path }) => {
    const findings: Finding[] = []
    const base = { id: doc.id, collection, title: doc.title || `#${doc.id}`, path }

    if (doc.meta?.noIndex) {
      return { ...base, status: 'ok', findings: [{ label: 'noindex — bewusst ausgenommen', severity: 'ok' }] }
    }

    // Titel
    const metaTitle = doc.meta?.title?.trim()
    if (!metaTitle) findings.push({ label: 'meta.title leer (Fallback doc.title)', severity: 'warn' })
    else if (metaTitle.length < LIMITS.TITLE_MIN || metaTitle.length > LIMITS.TITLE_MAX)
      findings.push({ label: `Titel ${metaTitle.length} Zeichen`, severity: 'warn' })
    if ((titles.get(norm(metaTitle || doc.title)) ?? 0) > 1)
      findings.push({ label: 'Titel doppelt', severity: 'error' })

    // Description
    const desc = doc.meta?.description?.trim()
    if (!desc) findings.push({ label: 'Description fehlt', severity: 'error' })
    else {
      if (desc.length < LIMITS.DESC_MIN || desc.length > LIMITS.DESC_MAX)
        findings.push({ label: `Description ${desc.length} Zeichen`, severity: 'warn' })
      if ((descs.get(norm(desc)) ?? 0) > 1) findings.push({ label: 'Description doppelt', severity: 'error' })
    }

    // OG-Bild
    const image = doc.meta?.image
    if (!image) findings.push({ label: 'Kein OG-Bild (Site-Default)', severity: 'warn' })
    else if (typeof image !== 'object')
      findings.push({ label: 'OG-Bild nicht populiert (depth)', severity: 'error' })
    else if (!(image as { alt?: string }).alt)
      findings.push({ label: 'OG-Bild ohne Alt-Text', severity: 'warn' })

    if (doc._status === 'draft') findings.push({ label: 'Entwurf', severity: 'ok' })

    return { ...base, findings, status: worst(findings) }
  })
}
```

→ Die Regeln bewusst **außerhalb** der React-Komponente halten: dieselbe Funktion lässt sich in einem `afterChange`-Hook, in einem CLI-Skript oder in Tests wiederverwenden.

### 5.2 Daten laden (`run.ts`)

```ts
// src/components/SeoCheck/run.ts
import type { CollectionSlug, TypedUser } from 'payload'
import configPromise from '@payload-config'
import { getPayload } from 'payload'
import { buildRows, type MetaDoc, type SeoRow } from './checks'

const COLLECTIONS: CollectionSlug[] = ['pages', 'posts']
const PREFIX: Partial<Record<CollectionSlug, string>> = { posts: '/posts' }
const MAX_DOCS = 500

export const runSeoCheck = async (
  user?: TypedUser | null,
): Promise<{ rows: SeoRow[]; truncated: boolean }> => {
  const payload = await getPayload({ config: configPromise })

  const results = await Promise.all(
    COLLECTIONS.map(async (collection) => {
      const { docs, totalDocs } = await payload.find({
        collection,
        depth: 1,                 // Pflicht: sonst ist meta.image nur eine ID
        limit: MAX_DOCS,
        overrideAccess: false,    // Redakteur sieht nur, worauf er Zugriff hat
        user: user ?? undefined,
        sort: 'title',
      })
      return {
        truncated: totalDocs > docs.length,
        items: (docs as MetaDoc[]).map((doc) => ({
          collection,
          doc,
          path: `${PREFIX[collection] ?? ''}/${doc.slug ?? ''}`.replace('/home', '/') || '/',
        })),
      }
    }),
  )

  return {
    rows: buildRows(results.flatMap((r) => r.items)),
    truncated: results.some((r) => r.truncated),
  }
}
```

→ **`limit` hart setzen und `truncated` anzeigen.** Ohne Limit (`limit: 0`) zieht der Check bei großen Sites alle Dokumente mit `depth: 1` in den Speicher — auf kleinen Hetzner-Instanzen ein OOM-Kandidat. Lieber 500 zeigen und ehrlich sagen, dass abgeschnitten wurde.

→ **`overrideAccess: false` + `user`**, sonst leakt die View Titel aus Collections, die der eingeloggte Redakteur gar nicht lesen darf.

### 5.3 Die View

```tsx
// src/components/SeoCheck/View.tsx
import type { AdminViewServerProps } from 'payload'
import { SetStepNav } from '@payloadcms/ui'
import { DefaultTemplate } from '@payloadcms/ui/rsc'
import { redirect } from 'next/navigation'
import React from 'react'
import { runSeoCheck } from './run'

const DOT: Record<string, string> = { ok: '🟢', warn: '🟡', error: '🔴' }

export async function SeoCheckView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { permissions, req, visibleEntities } = initPageResult
  const adminRoute = req.payload.config.routes.admin

  if (!req.user || !permissions?.canAccessAdmin) return redirect(`${adminRoute}/unauthorized`)

  const { rows, truncated } = await runSeoCheck(req.user)
  const count = (s: string) => rows.filter((r) => r.status === s).length

  return (
    <DefaultTemplate
      i18n={req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={req.payload}
      permissions={permissions}
      searchParams={searchParams}
      user={req.user}
      visibleEntities={visibleEntities}
    >
      <SetStepNav nav={[{ label: 'SEO-Check' }]} />
      <div style={{ padding: '0 var(--gutter-h)' }}>
        <h1>SEO-Check</h1>
        <p>
          {DOT.ok} {count('ok')} in Ordnung &nbsp;·&nbsp; {DOT.warn} {count('warn')} Hinweise
          &nbsp;·&nbsp; {DOT.error} {count('error')} Fehler
          {truncated ? ' · Liste gekürzt (Limit erreicht)' : ''}
        </p>

        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '2rem' }} />
              <th>Seite</th>
              <th>Pfad</th>
              <th>Befunde</th>
            </tr>
          </thead>
          <tbody>
            {/* Fehler zuerst — die Liste soll oben handlungsfähig sein */}
            {[...rows]
              .sort((a, b) => ['error', 'warn', 'ok'].indexOf(a.status) - ['error', 'warn', 'ok'].indexOf(b.status))
              .map((row) => (
                <tr key={`${row.collection}-${row.id}`}>
                  <td>{DOT[row.status]}</td>
                  <td>
                    <a href={`${adminRoute}/collections/${row.collection}/${row.id}`}>{row.title}</a>
                  </td>
                  <td style={{ color: 'var(--theme-elevation-500)' }}>{row.path}</td>
                  <td>
                    {row.findings.length === 0
                      ? '—'
                      : row.findings.map((f) => f.label).join(' · ')}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </DefaultTemplate>
  )
}
```

→ `DefaultTemplate` kommt aus **`@payloadcms/ui/rsc`** (ältere Beispiele zeigen `@payloadcms/next/templates`). Ohne das Template rendert die View ohne Sidebar/Nav.

→ Der Auth-Guard (`permissions.canAccessAdmin`) ist **nicht optional** — Custom-Views laufen sonst auch für nicht berechtigte Sessions.

### 5.4 Das Dashboard-Widget

```tsx
// src/components/SeoCheck/Widget.tsx
import type { ServerProps } from 'payload'
import React from 'react'
import { runSeoCheck } from './run'

export async function SeoCheckWidget({ payload, user }: ServerProps) {
  const { rows } = await runSeoCheck(user)
  const errors = rows.filter((r) => r.status === 'error').length
  const warns = rows.filter((r) => r.status === 'warn').length
  const adminRoute = payload.config.routes.admin

  return (
    <div style={{ border: '1px solid var(--theme-elevation-150)', borderRadius: 'var(--style-radius-m)', padding: 'var(--base)' }}>
      <h4 style={{ margin: 0 }}>SEO-Status</h4>
      <p style={{ margin: '0.5rem 0' }}>
        {rows.length} Seiten geprüft — <strong>{errors}</strong> Fehler, <strong>{warns}</strong> Hinweise
      </p>
      <a href={`${adminRoute}/seo-check`}>Details ansehen →</a>
    </div>
  )
}
```

### 5.5 Verdrahtung

```ts
// src/payload.config.ts
admin: {
  components: {
    beforeDashboard: ['@/components/SeoCheck/Widget#SeoCheckWidget'],
    afterNavLinks: ['@/components/SeoCheck/NavLink#SeoCheckNavLink'],
    views: {
      seoCheck: {
        Component: '@/components/SeoCheck/View#SeoCheckView',
        path: '/seo-check',
        exact: true,
        meta: { title: 'SEO-Check' },
      },
    },
  },
}
```

```tsx
// src/components/SeoCheck/NavLink.tsx
'use client'
import { Link, useConfig } from '@payloadcms/ui'
import React from 'react'

export const SeoCheckNavLink: React.FC = () => {
  const { config: { routes: { admin } } } = useConfig()
  return (
    <p className="nav__link" style={{ margin: 0 }}>
      <Link href={`${admin}/seo-check`}>SEO-Check</Link>
    </p>
  )
}
```

```bash
pnpm payload generate:importmap
```

→ **Der Import-Map-Schritt wird ständig vergessen.** Ohne ihn wird die Komponente stillschweigend nicht geladen — die View ist dann leer oder 404, ohne Fehlermeldung. Nach **jeder** Änderung an registrierten Komponentenpfaden neu ausführen (und in der CI vor dem Build).

→ **Performance:** Widget + View laufen bei jedem Dashboard-Aufruf. Ab ~200 Dokumenten das Ergebnis mit `unstable_cache` (Tag `seo-check`) puffern und den Tag in einem `afterChange`-Hook der geprüften Collections per `revalidateTag` invalidieren — dasselbe Muster wie in [`performance/`](../performance/description.md).

## 6. Schwellwerte

| Feld | Zielbereich | Verstoß |
| --- | --- | --- |
| `meta.title` | 30–60 Zeichen, pro Seite eindeutig | leer → Hinweis (Fallback greift); doppelt → Fehler |
| `meta.description` | 70–160 Zeichen, pro Seite eindeutig | leer → Fehler; doppelt → Fehler |
| `meta.image` | 1200×630, JPG/PNG, `alt` gesetzt | fehlt → Hinweis (Site-Default greift); nicht populiert → Fehler (depth-Bug) |
| `noIndex` | bewusst gesetzt | schaltet alle anderen Regeln für die Seite ab |

## Quick-Checkliste

1. `mergeOpenGraph`: leere Werte via `definedOnly()` filtern, `images`-Sonderfall entfernen
2. Default-OG-Bild als `public/og-default.jpg` (1200×630, JPG/PNG) — Template-Pfad `/website-template-OG.webp` existiert nicht
3. `resolveOgImage`: `sizes.og` bevorzugen, `getMediaUrl()` statt `serverUrl + url`, bei nicht-populiertem `meta.image` im Dev warnen
4. `og`-Bildgröße (1200×630) in `Media.upload.imageSizes` anlegen
5. Alle Seiten-Queries auf `depth >= 1` prüfen; bei `select` unbedingt `meta` mitselektieren
6. `twitter` pro Seite explizit setzen (Next.js leitet nichts aus `openGraph` ab)
7. `checks.ts` / `run.ts` / `View.tsx` / `Widget.tsx` anlegen, in `payload.config.ts` registrieren
8. `pnpm payload generate:importmap` — auch in der CI vor dem Build
9. `runSeoCheck` mit `overrideAccess: false` + `user` und hartem `limit`
10. Vor Livegang: OG-Tags mit dem Facebook Sharing Debugger / LinkedIn Post Inspector gegenprüfen (beide cachen — nach Fix Re-Scrape auslösen)
