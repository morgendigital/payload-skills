import config from '@payload-config'
import { getPayload } from 'payload'
import sharp from 'sharp'

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
 * This script is deliberately slow. An earlier version loaded the whole
 * collection at once (`limit: 0, pagination: false`) and let Sharp use every
 * core; run against production it took the server down — see description.md,
 * "Wie dieses Skript einen Server lahmgelegt hat". Everything here is paged,
 * single-file-at-a-time and throttled. Do not "optimize" that away.
 *
 * Configured through the environment, not flags: `payload run` swallows every
 * argument after the script path — process.argv reaches the script holding only
 * payload's own bin path.
 *
 * Dry run (default — writes nothing):
 *   pnpm payload run src/scripts/regenerateMediaVariants.ts
 * One document, for real:
 *   APPLY=1 MEDIA_ID=<id> pnpm payload run src/scripts/regenerateMediaVariants.ts
 * A batch, deprioritized against the rest of the machine (how to run in prod):
 *   nice -n 19 ionice -c 3 env APPLY=1 LIMIT=100 \
 *     pnpm payload run src/scripts/regenerateMediaVariants.ts
 * Everything (only on a machine nobody is using):
 *   APPLY=1 pnpm payload run src/scripts/regenerateMediaVariants.ts
 */

const MEDIA_SOURCE = process.env.MEDIA_SOURCE ?? 'https://www.rtbrick.com'

const APPLY = process.env.APPLY === '1' || process.env.APPLY === 'true'
const ONLY_ID = process.env.MEDIA_ID || undefined
const LIMIT = Number(process.env.LIMIT ?? 0)
/** Repair hatch: re-file a document under a different name (see MEDIA_ID). */
const FORCE_NAME = process.env.FORCE_NAME || undefined

/** Documents held in memory at once. Small on purpose — see the header. */
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100)
/**
 * Sharp threads. Its default is "one per core", and every `payload.update()`
 * with a file attached runs the full pipeline for seven sizes — that is what
 * saturated the CPU. Two leaves the app server room to answer requests.
 */
const SHARP_CONCURRENCY = Number(process.env.SHARP_CONCURRENCY ?? 2)
/** Idle gap between documents, so disk and CPU are not pinned continuously. */
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 200)

sharp.concurrency(SHARP_CONCURRENCY)

type SizeEntry = { filename?: string | null; filesize?: number | null; mimeType?: string | null }

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bytes across every derivative — the number this script is trying to shrink. */
const derivativeBytes = (sizes: Record<string, SizeEntry> | null | undefined) =>
  Object.values(sizes ?? {}).reduce((sum, s) => sum + (s?.filesize ?? 0), 0)

const nonWebpSizes = (sizes: Record<string, SizeEntry> | null | undefined) =>
  Object.entries(sizes ?? {}).filter(
    ([, s]) => s?.filename && s.mimeType && s.mimeType !== 'image/webp',
  )

const run = async () => {
  const payload = await getPayload({ config })

  const isRaster = (mimeType: unknown) =>
    typeof mimeType === 'string' && mimeType.startsWith('image/') && !mimeType.includes('svg')

  let scanned = 0
  let matched = 0
  let processed = 0
  let before = 0
  let after = 0
  let failed = 0

  if (!APPLY) payload.logger.info('DRY RUN — pass APPLY=1 to write. Nothing is modified.')
  payload.logger.info(
    `page size ${PAGE_SIZE}, sharp concurrency ${SHARP_CONCURRENCY}, ${PAUSE_MS} ms between documents` +
      (LIMIT > 0 ? `, stopping after ${LIMIT} documents` : ''),
  )

  // Paged, one page live at a time. `sort: 'createdAt'` keeps paging stable:
  // the default sort is by `-createdAt` in most configs, but an explicit,
  // never-written field is the only thing that guarantees a document cannot
  // move between pages while the loop is updating documents.
  for (let page = 1; ; page++) {
    const result = await payload.find({
      collection: 'media',
      limit: PAGE_SIZE,
      page,
      depth: 0,
      sort: 'createdAt',
      overrideAccess: true,
      // Only the fields this script reads. Keeps the working set small and
      // stops Mongo from handing over documents wholesale.
      select: { filename: true, mimeType: true, sizes: true },
      ...(ONLY_ID ? { where: { id: { equals: ONLY_ID } } } : {}),
    })

    scanned += result.docs.length

    // Only rasters with at least one derivative in the wrong format. SVGs have
    // no derivatives, and PDFs/ZIPs are not images at all.
    //
    // A document named explicitly through MEDIA_ID skips the format check — it
    // is also how you re-file one under a different name (FORCE_NAME), which
    // has nothing to do with whether its derivatives are already WebP.
    const targets = result.docs.filter(
      (doc) =>
        isRaster(doc.mimeType) &&
        (ONLY_ID != null || nonWebpSizes(doc.sizes as never).length > 0),
    )
    matched += targets.length

    for (const doc of targets) {
      if (LIMIT > 0 && processed >= LIMIT) break

      const sizesBefore = derivativeBytes(doc.sizes as never)
      before += sizesBefore
      processed++

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

      // One Sharp pipeline per document is enough load; give the box a gap.
      if (PAUSE_MS > 0) await sleep(PAUSE_MS)
    }

    if (LIMIT > 0 && processed >= LIMIT) {
      payload.logger.info(`LIMIT ${LIMIT} reached — run again for the next batch`)
      break
    }
    if (!result.hasNextPage) break
  }

  payload.logger.info(
    `${matched} of ${scanned} media documents have non-WebP derivatives` +
      (matched !== processed ? ` — processed ${processed}` : ''),
  )

  if (APPLY) {
    payload.logger.info(
      `Derivatives: ${kb(before)} → ${kb(after)} across ${processed - failed} documents` +
        (failed ? `, ${failed} failed` : ''),
    )
  } else {
    payload.logger.info(`Derivatives currently occupying ${kb(before)}`)
  }

  process.exit(failed > 0 ? 1 : 0)
}

await run()
