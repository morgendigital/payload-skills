import config from '@payload-config'
import { getPayload } from 'payload'

/**
 * Re-encodes existing media derivatives as WebP.
 *
 * `upload.formatOptions` converts only the main file. Derivatives keep the
 * format they were uploaded in unless their size entry says otherwise, so every
 * PNG or JPEG upload produced a WebP original and a set of PNG/JPEG derivatives
 * — and those derivatives are what next/image serves. Media.ts now sets
 * formatOptions per size, which fixes new uploads; this fixes the old ones.
 *
 * Payload regenerates the whole size set whenever a document is updated with a
 * file attached, so the work is: fetch the original back, hand it in again.
 *
 * Reads the original over HTTP rather than from storage so it works the same
 * whether media lives on S3 or a local volume. Point MEDIA_SOURCE at whichever
 * host serves the current files.
 *
 * Configured through the environment, not flags: `payload run` swallows every
 * argument after the script path — process.argv reaches the script holding only
 * payload's own bin path.
 *
 * Dry run (default — writes nothing):
 *   pnpm payload run src/scripts/regenerateMediaVariants.ts
 * One document, for real:
 *   APPLY=1 MEDIA_ID=<id> pnpm payload run src/scripts/regenerateMediaVariants.ts
 * A first batch:
 *   APPLY=1 LIMIT=10 pnpm payload run src/scripts/regenerateMediaVariants.ts
 * Everything:
 *   APPLY=1 pnpm payload run src/scripts/regenerateMediaVariants.ts
 */

const MEDIA_SOURCE = process.env.MEDIA_SOURCE ?? 'https://www.rtbrick.com'

const APPLY = process.env.APPLY === '1' || process.env.APPLY === 'true'
const ONLY_ID = process.env.MEDIA_ID || undefined
const LIMIT = Number(process.env.LIMIT ?? 0)
/** Repair hatch: re-file a document under a different name (see MEDIA_ID). */
const FORCE_NAME = process.env.FORCE_NAME || undefined

type SizeEntry = { filename?: string | null; filesize?: number | null; mimeType?: string | null }

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

/** Bytes across every derivative — the number this script is trying to shrink. */
const derivativeBytes = (sizes: Record<string, SizeEntry> | null | undefined) =>
  Object.values(sizes ?? {}).reduce((sum, s) => sum + (s?.filesize ?? 0), 0)

const nonWebpSizes = (sizes: Record<string, SizeEntry> | null | undefined) =>
  Object.entries(sizes ?? {}).filter(
    ([, s]) => s?.filename && s.mimeType && s.mimeType !== 'image/webp',
  )

const run = async () => {
  const payload = await getPayload({ config })

  const { docs } = await payload.find({
    collection: 'media',
    limit: 0,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    ...(ONLY_ID ? { where: { id: { equals: ONLY_ID } } } : {}),
  })

  const isRaster = (doc: (typeof docs)[number]) =>
    typeof doc.mimeType === 'string' &&
    doc.mimeType.startsWith('image/') &&
    !doc.mimeType.includes('svg')

  // Only rasters with at least one derivative in the wrong format. SVGs have no
  // derivatives, and PDFs/ZIPs are not images at all.
  //
  // A document named explicitly through MEDIA_ID skips the format check — it is
  // also how you re-file one under a different name (FORCE_NAME), which has
  // nothing to do with whether its derivatives are already WebP.
  const candidates = docs.filter(
    (doc) => isRaster(doc) && (ONLY_ID != null || nonWebpSizes(doc.sizes as never).length > 0),
  )

  const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates

  payload.logger.info(
    `${candidates.length} of ${docs.length} media documents have non-WebP derivatives` +
      (LIMIT > 0 ? ` — processing ${targets.length}` : ''),
  )
  if (!APPLY) payload.logger.info('DRY RUN — pass --apply to write. Nothing is modified.')

  let before = 0
  let after = 0
  let failed = 0

  for (const doc of targets) {
    const sizesBefore = derivativeBytes(doc.sizes as never)
    before += sizesBefore

    if (!APPLY) {
      payload.logger.info(
        `  ${doc.filename} — ${nonWebpSizes(doc.sizes as never).length} derivatives, ${kb(sizesBefore)}`,
      )
      continue
    }

    try {
      const url = `${MEDIA_SOURCE}/api/media/file/${encodeURIComponent(String(doc.filename))}`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`fetch ${response.status}`)

      const data = Buffer.from(await response.arrayBuffer())

      const updated = await payload.update({
        collection: 'media',
        id: doc.id,
        data: {},
        file: {
          data,
          mimetype: String(doc.mimeType),
          name: FORCE_NAME ?? String(doc.filename),
          size: data.length,
        },
        // Without this Payload treats the existing file as a clash and appends
        // a counter: "Angacom 2026.webp" becomes "Angacom 2026-1.webp", the old
        // URL 404s, and anything linking to the file by URL rather than by
        // relationship breaks. Overwriting keeps every existing link valid.
        overwriteExistingFiles: true,
        overrideAccess: true,
        // Seed-style scripts run outside a request, where revalidatePath throws.
        context: { disableRevalidate: true },
      })

      const sizesAfter = derivativeBytes(updated.sizes as never)
      after += sizesAfter
      payload.logger.info(
        `  ${doc.filename}: ${kb(sizesBefore)} → ${kb(sizesAfter)}` +
          ` (${Math.round((1 - sizesAfter / Math.max(sizesBefore, 1)) * 100)}% smaller)`,
      )
    } catch (error) {
      failed++
      payload.logger.error(`  ${doc.filename}: FAILED — ${(error as Error).message}`)
    }
  }

  if (APPLY) {
    payload.logger.info(
      `Derivatives: ${kb(before)} → ${kb(after)} across ${targets.length - failed} documents` +
        (failed ? `, ${failed} failed` : ''),
    )
  } else {
    payload.logger.info(`Derivatives currently occupying ${kb(before)}`)
  }

  process.exit(failed > 0 ? 1 : 0)
}

await run()
