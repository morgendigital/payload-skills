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

### 5.3 Die View — problemorientiert statt Tabellen-Dump

**Der UX-Fehler der ersten Version war die Sortierung nach Dokument.** Eine Liste mit 40 Zeilen
„Description fehlt" beantwortet nicht die Frage, die die Redaktion tatsächlich hat: *Was mache
ich als Nächstes, und wie lange dauert es?* Deshalb steht oben eine **Befund-Liste** (ein Eintrag
pro Problemart mit Anzahl), und die Dokumenttabelle darunter ist gefiltert. Jeder Befund ist ein
Filter-Link — die View ist damit vollständig über die URL steuerbar (`?issue=desc-missing`),
bookmarkbar und ohne Client-State.

Dafür brauchen Findings **eine ID und ein Zielfeld** — `checks.ts` aus 5.1 entsprechend erweitern:

```ts
// src/components/SeoCheck/checks.ts
export type IssueId =
  | 'title-missing' | 'title-length' | 'title-duplicate'
  | 'desc-missing'  | 'desc-length'  | 'desc-duplicate'
  | 'image-missing' | 'image-depth'  | 'image-alt'

export type Finding = {
  id: IssueId
  label: string
  severity: Severity
  /** Feldpfad für den Deep-Link, z. B. 'meta.title' */
  field?: string
}

export const ISSUE_LABELS: Record<IssueId, string> = {
  'title-missing': 'meta.title leer (Fallback greift)',
  'title-duplicate': 'Titel doppelt',
  'desc-missing': 'Description fehlt',
  // …
}

// statt push({ label: 'Description fehlt', severity: 'error' }):
findings.push({
  id: 'desc-missing', label: ISSUE_LABELS['desc-missing'],
  severity: 'error', field: 'meta.description',
})
```

→ **Warum das Feld mitkommt:** Payload vergibt Feld-IDs nach dem Muster
`field-${path.replace(/\./g, '__')}`. Aus `meta.description` wird also der Anker
`#field-meta__description` — der Link aus dem Dashboard landet damit **im richtigen Feld** statt
nur irgendwo im Dokument. Das ist der Unterschied zwischen „Liste zum Abarbeiten" und „Bericht
zum Ausdrucken".

```tsx
// src/components/SeoCheck/View.tsx
import type { AdminViewServerProps } from 'payload'
import { Banner, Button, Gutter, Pill, SetStepNav } from '@payloadcms/ui'
import { DefaultTemplate } from '@payloadcms/ui/rsc'
import { redirect } from 'next/navigation'
import React from 'react'
import { ISSUE_LABELS, type IssueId, type Severity } from './checks'
import { runSeoCheck } from './run'

const PILL: Record<Severity, 'error' | 'success' | 'warning'> = {
  error: 'error', warn: 'warning', ok: 'success',
}
const STATUS_LABEL: Record<Severity, string> = { error: 'Fehler', warn: 'Hinweis', ok: 'OK' }

const anchor = (field?: string) => (field ? `#field-${field.replace(/\./g, '__')}` : '')

export async function SeoCheckView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { permissions, req, visibleEntities } = initPageResult
  const adminRoute = req.payload.config.routes.admin
  if (!req.user || !permissions?.canAccessAdmin) return redirect(`${adminRoute}/unauthorized`)

  const issue = typeof searchParams?.issue === 'string' ? (searchParams.issue as IssueId) : undefined
  const status = typeof searchParams?.status === 'string' ? (searchParams.status as Severity) : undefined

  const { checkedAt, rows, truncated } = await runSeoCheck(req.user)

  // Befunde zählen — das ist die eigentliche Arbeitsliste
  const counts = new Map<IssueId, { count: number; severity: Severity }>()
  for (const row of rows) {
    for (const f of row.findings) {
      if (f.severity === 'ok') continue
      counts.set(f.id, { count: (counts.get(f.id)?.count ?? 0) + 1, severity: f.severity })
    }
  }
  const issues = [...counts.entries()].sort((a, b) =>
    a[1].severity === b[1].severity ? b[1].count - a[1].count : a[1].severity === 'error' ? -1 : 1,
  )

  const visible = rows
    .filter((r) => (issue ? r.findings.some((f) => f.id === issue) : true))
    .filter((r) => (status ? r.status === status : r.status !== 'ok'))
    .sort((a, b) => ['error', 'warn', 'ok'].indexOf(a.status) - ['error', 'warn', 'ok'].indexOf(b.status))

  const link = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ issue, status, ...next })) if (v) p.set(k, String(v))
    return `${adminRoute}/seo-check${[...p].length ? `?${p}` : ''}`
  }

  return (
    <DefaultTemplate
      i18n={req.i18n} locale={initPageResult.locale} params={params} payload={req.payload}
      permissions={permissions} searchParams={searchParams} user={req.user}
      visibleEntities={visibleEntities}
    >
      <SetStepNav nav={[{ label: 'SEO-Check' }]} />
      <Gutter>
        <h1>SEO-Check</h1>

        {issues.length === 0 ? (
          <Banner type="success">
            Alle {rows.length} Seiten haben Titel, Description und Bild — nichts zu tun.
          </Banner>
        ) : (
          <>
            {/* 1. Arbeitsliste: was ist zu tun, und wie oft */}
            <ul style={{ display: 'grid', gap: 'calc(var(--base) / 2)', listStyle: 'none', padding: 0 }}>
              {issues.map(([id, { count, severity }]) => (
                <li key={id}>
                  <Button
                    buttonStyle={issue === id ? 'primary' : 'secondary'} el="link"
                    to={link({ issue: issue === id ? undefined : id, status: undefined })}
                  >
                    <Pill pillStyle={PILL[severity]} size="small">{count}</Pill>
                    &nbsp;{ISSUE_LABELS[id]}
                  </Button>
                </li>
              ))}
            </ul>

            {/* 2. Statusfilter — ohne Filter zeigt die Tabelle NUR Auffälliges */}
            <div style={{ display: 'flex', gap: 'calc(var(--base) / 2)', margin: 'var(--base) 0' }}>
              {(['error', 'warn', 'ok'] as Severity[]).map((s) => (
                <Button key={s} buttonStyle={status === s ? 'primary' : 'secondary'} el="link"
                        to={link({ status: status === s ? undefined : s })}>
                  {STATUS_LABEL[s]} ({rows.filter((r) => r.status === s).length})
                </Button>
              ))}
            </div>
          </>
        )}

        {truncated && (
          <Banner type="warning">
            Liste gekürzt — es wurden nur die ersten Dokumente geprüft. Limit in <code>run.ts</code> anheben.
          </Banner>
        )}

        <table className="table">
          <thead>
            <tr><th>Status</th><th>Seite</th><th>Pfad</th><th>Befunde</th></tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={`${row.collection}-${row.id}`}>
                <td><Pill pillStyle={PILL[row.status]} size="small">{STATUS_LABEL[row.status]}</Pill></td>
                <td><a href={`${adminRoute}/collections/${row.collection}/${row.id}`}>{row.title}</a></td>
                <td><a href={row.path} rel="noreferrer" target="_blank">{row.path}</a></td>
                <td>
                  {row.findings.filter((f) => f.severity !== 'ok').map((f) => (
                    // Deep-Link direkt in das betroffene Feld
                    <a key={f.id}
                       href={`${adminRoute}/collections/${row.collection}/${row.id}${anchor(f.field)}`}>
                      {f.label}
                    </a>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ color: 'var(--theme-elevation-500)' }}>
          {visible.length} von {rows.length} Seiten · Stand: {checkedAt.toLocaleString('de-AT')}
        </p>
      </Gutter>
    </DefaultTemplate>
  )
}
```

→ **`Pill` ist ein `div`, kein Button.** Es nimmt weder `onClick` noch `href` entgegen (nur
`elementProps`). Klickbare Filter deshalb als `Button` mit `el="link"` + `to`, und `Pill`
ausschließlich als Statusanzeige darin. Wer `onClick` an ein `Pill` hängt, baut ein Element, das
mit der Tastatur nicht erreichbar ist — genau das, was
[`accessibility/`](../accessibility/description.md) später anschlägt.

→ **Emojis raus.** 🟢/🟡/🔴 tragen den Status in der ersten Version **allein**: im Screenreader
kommt „großer grüner Kreis" an, bei Rot-Grün-Schwäche nichts Unterscheidbares. `Pill` mit Text
löst beides — und sieht im **Dark Mode** richtig aus, weil es die Admin-Tokens statt eigener
Inline-Farben nutzt. Dasselbe gilt für die restlichen Inline-Styles: nur noch `var(--base)`,
`var(--theme-elevation-*)`, sonst driftet die View bei jedem Admin-Theme-Update weg.

→ **Default-Filter ist „nicht OK".** Ohne Filter zeigt die Tabelle nur Fehler und Hinweise. Eine
Liste, in der 90 % der Zeilen „alles gut" sagen, wird nach dem zweiten Mal nicht mehr geöffnet.

→ **Mehrsprachige Projekte:** `runSeoCheck` pro Locale laufen lassen und die Locale als Spalte
mitführen. Sonst prüft die View stillschweigend nur die Default-Locale — und meldet gleichzeitig
falsche „Titel doppelt"-Fehler, sobald zwei Sprachversionen denselben Titel tragen (Duplikate
immer **innerhalb** einer Locale zählen).

### 5.4 Das Dashboard-Widget

```tsx
// src/components/SeoCheck/Widget.tsx
import type { ServerProps } from 'payload'
import { Banner } from '@payloadcms/ui'
import React from 'react'
import { runSeoCheck } from './run'

export async function SeoCheckWidget({ payload, user }: ServerProps) {
  const { rows } = await runSeoCheck(user)
  if (!rows.length) return null // nichts zu prüfen → kein leeres Kästchen aufs Dashboard

  const errors = rows.filter((r) => r.status === 'error').length
  const warns = rows.filter((r) => r.status === 'warn').length
  const admin = payload.config.routes.admin

  return (
    <Banner
      type={errors ? 'danger' : warns ? 'warning' : 'success'}
      to={`${admin}/seo-check${errors ? '?status=error' : ''}`}
    >
      {errors
        ? `SEO: ${errors} Seiten mit Fehlern${warns ? `, ${warns} mit Hinweisen` : ''} — jetzt ansehen`
        : warns
          ? `SEO: ${warns} Hinweise auf ${rows.length} Seiten`
          : `SEO: alle ${rows.length} Seiten vollständig gepflegt`}
    </Banner>
  )
}
```

→ **Ein Satz, eine Farbe, ein Ziel.** Das Widget steht über dem Dashboard und konkurriert mit den
Collection-Kacheln — es darf keine zweite Tabelle sein. Der Link springt direkt in den gefilterten
Zustand (`?status=error`), damit der Klick nicht in derselben Übersicht landet, aus der man kam.

→ **Den Erfolgsfall anzeigen.** Ein Widget, das nur bei Fehlern erscheint, wirkt kaputt („war das
da nicht mal?"). Grün ist die Bestätigung, dass überhaupt geprüft wurde.

### 5.5 Live-Check im Editor — der eigentliche UX-Gewinn

Ein Dashboard ist eine Holschuld: Jemand muss es aufrufen. Die Regeln gehören dorthin, wo der Text
entsteht — in die Sidebar neben die SEO-Felder. `@payloadcms/plugin-seo` bringt Zeichenzähler und
Suchergebnis-Vorschau mit, aber **keine Regeln**; ein `ui`-Feld ergänzt genau das, mit **derselben**
`checks.ts`:

```tsx
// src/components/SeoCheck/FieldCheck.tsx
'use client'
import { Pill, useFormFields } from '@payloadcms/ui'
import React from 'react'
import { checkDoc } from './checks' // die Ein-Dokument-Regeln, aus buildRows herausgezogen

export const SeoFieldCheck: React.FC = () => {
  // Ein Hook pro Feld — der Selector darf KEIN neues Array/Objekt zurückgeben (siehe unten)
  const docTitle = useFormFields(([f]) => f?.title?.value as string)
  const metaTitle = useFormFields(([f]) => f?.['meta.title']?.value as string)
  const metaDesc = useFormFields(([f]) => f?.['meta.description']?.value as string)
  const metaImage = useFormFields(([f]) => f?.['meta.image']?.value as string)

  const findings = checkDoc({
    title: docTitle,
    meta: { description: metaDesc, image: metaImage, title: metaTitle },
  }).filter((f) => f.severity !== 'ok')

  if (!findings.length) return <Pill pillStyle="success" size="small">SEO vollständig</Pill>

  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      {findings.map((f) => (
        <Pill key={f.id} pillStyle={f.severity === 'error' ? 'error' : 'warning'} size="small">
          {f.label}
        </Pill>
      ))}
    </div>
  )
}
```

```ts
// src/plugins/index.ts — das UI-Feld in die SEO-Gruppe hängen
seoPlugin({
  generateDescription, generateTitle, generateURL,
  fields: ({ defaultFields }) => [
    ...defaultFields,
    {
      name: 'seoStatus',
      type: 'ui',
      admin: { components: { Field: '@/components/SeoCheck/FieldCheck#SeoFieldCheck' } },
    },
  ],
})
```

→ **`useFormFields`-Falle:** Der Selector läuft bei **jeder** Formularänderung. Gibt er ein neu
erzeugtes Array oder Objekt zurück, ist die Referenz jedes Mal neu und die Komponente rendert
erneut — im schlechtesten Fall in einer Schleife, die den Editor spürbar ausbremst. Deshalb pro
Feld ein Aufruf mit primitivem Rückgabewert.

→ **Was hier nicht geht: die Duplikatprüfung.** „Titel doppelt" braucht alle Dokumente und bleibt
im Dashboard. Genau deshalb die Regeln in `checkDoc` (ein Dokument, clientfähig) und `buildRows`
(site-weit, serverseitig) trennen — **eine** Regel-Definition, zwei Oberflächen. Zwei Regelsätze,
die auseinanderdriften, sind schlimmer als gar kein Check.

### 5.6 Ergebnis cachen — ab ~200 Dokumenten Pflicht

Widget **und** View laufen bei jedem Dashboard-Aufruf, beide mit `depth: 1` über alle Dokumente.
Ohne Cache zahlt jeder Admin-Login das doppelt:

```ts
// src/components/SeoCheck/run.ts
import { unstable_cache } from 'next/cache'

const cached = unstable_cache(
  async () => ({ ...(await collect()), checkedAt: new Date() }),
  ['seo-check'],
  { revalidate: 3600, tags: ['seo-check'] },
)
```

und in den `afterChange`/`afterDelete`-Hooks der geprüften Collections `revalidateTag('seo-check')` —
dasselbe Muster wie bei den Sitemap-Routen in [`seo/`](../seo/description.md).

→ **`checkedAt` mit ausgeben.** Ein gecachter Wert ohne Zeitstempel führt garantiert zu „ich habe
das doch gerade korrigiert". Dazu ein „Neu prüfen"-Button mit einer Server Action, die
`revalidateTag('seo-check')` aufruft.

→ **Cache und `overrideAccess: false` vertragen sich nicht automatisch.** Ein Cache-Key ohne
Benutzerbezug liefert dem nächsten Redakteur das Ergebnis des vorigen. Entweder die Rolle in den
Cache-Key aufnehmen oder den Cache nur für Rollen nutzen, die ohnehin alles lesen dürfen.

### 5.7 Verdrahtung

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

→ **Auch das `ui`-Feld aus 5.5 braucht die Import-Map.** Es wird über denselben Mechanismus
aufgelöst wie View und Widget — fehlt der Lauf, ist die Sidebar einfach leer, ohne Fehler.

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
7. `checks.ts` / `run.ts` / `View.tsx` / `Widget.tsx` / `FieldCheck.tsx` anlegen, in `payload.config.ts` registrieren
8. `pnpm payload generate:importmap` — auch in der CI vor dem Build
9. `runSeoCheck` mit `overrideAccess: false` + `user` und hartem `limit`
10. Findings mit `id` **und** `field` versehen — nur dann führt der Befund per `#field-meta__…`-Anker ins richtige Feld
11. Statt Emoji-Punkten `Pill`/`Banner` aus `@payloadcms/ui`; klickbare Filter als `Button el="link"`, nie als `Pill`
12. Regeln in `checkDoc` (ein Dokument, clientfähig) und `buildRows` (site-weit) trennen; Live-Check als `ui`-Feld über `seoPlugin({ fields })` in die Sidebar hängen
13. `unstable_cache` mit Tag `seo-check` + `revalidateTag` im Hook, `checkedAt` in der View anzeigen
14. Vor Livegang: OG-Tags mit dem Facebook Sharing Debugger / LinkedIn Post Inspector gegenprüfen (beide cachen — nach Fix Re-Scrape auslösen)
