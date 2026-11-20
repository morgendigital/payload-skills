/**
 * Fills the blurred loading placeholder (`blurDataURL`) for media uploaded before the upload hook
 * existed (generateBlurDataURL.ts) — without opening and re-saving every image in the admin.
 * New uploads get it from the hook; this is only for the existing stock.
 *
 * Copy to src/scripts/backfillBlurDataURLs.ts. Run (dry run by default, writes nothing):
 *   pnpm payload run src/scripts/backfillBlurDataURLs.ts
 *   APPLY=1 pnpm payload run src/scripts/backfillBlurDataURLs.ts
 *   APPLY=1 MEDIA_ID=<id> ...      one document
 *   APPLY=1 FORCE=1 ...            also redo documents that already have one
 *   APPLY=1 LIMIT=100 ...          stop after 100 documents (run again for the next)
 *
 * Environment, not flags: `payload run` swallows every argument after the script path.
 *
 * Bytes come over HTTP from MEDIA_SOURCE (default NEXT_PUBLIC_SERVER_URL), the same whether the
 * files sit in S3 or on a local volume, and the 300px `thumbnail` size is read instead of the
 * original (up to 4096px): the result is a 16px blur either way, the download ~8 KB instead of
 * several hundred.
 *
 * Written with `payload.db.updateOne`, NOT `payload.update`: update bumps `updatedAt` (which is
 * the imgproxy / CDN cache buster — every touched image would be re-encoded once) and runs the
 * media hooks and their revalidation. The Mongo adapter leaves `updatedAt` alone on db.updateOne;
 * other adapters: check before relying on it.
 *
 * Gentle on purpose (see media-webp-variants): paged, one file at a time, sharp on two threads,
 * a short pause between documents.
 */
import { getPayload } from 'payload'
import sharp from 'sharp'

import config from '@payload-config'

import { makeBlurDataURL } from '../utilities/makeBlurDataURL'

const MEDIA_SOURCE = (process.env.MEDIA_SOURCE || process.env.NEXT_PUBLIC_SERVER_URL || '').replace(
  /\/$/,
  '',
)

const APPLY = process.env.APPLY === '1' || process.env.APPLY === 'true'
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true'
const ONLY_ID = process.env.MEDIA_ID || undefined
const LIMIT = Number(process.env.LIMIT ?? 0)
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100)
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 100)

sharp.concurrency(Number(process.env.SHARP_CONCURRENCY ?? 2))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const payload = await getPayload({ config })

if (!MEDIA_SOURCE) {
  payload.logger.error('Set MEDIA_SOURCE (or NEXT_PUBLIC_SERVER_URL), e.g. https://www.example.com')
  process.exit(1)
}

payload.logger.info(
  `${APPLY ? 'APPLY' : 'DRY RUN — pass APPLY=1 to write'} · source ${MEDIA_SOURCE}` +
    (FORCE ? ' · FORCE (redo existing)' : '') +
    (LIMIT > 0 ? ` · stopping after ${LIMIT}` : ''),
)

let scanned = 0
let todo = 0
let written = 0
let notApplicable = 0
let failed = 0

pages: for (let page = 1; ; page++) {
  // No `where` on blurDataURL: written documents would drop out of the result and shift the
  // following pages (documents skipped). Fixed sort + filtering in code keeps paging stable.
  const result = await payload.find({
    collection: 'media',
    limit: PAGE_SIZE,
    page,
    depth: 0,
    sort: 'createdAt',
    overrideAccess: true,
    select: {
      blurDataURL: true,
      filename: true,
      mimeType: true,
      sizes: { thumbnail: { filename: true } },
    },
    ...(ONLY_ID ? { where: { id: { equals: ONLY_ID } } } : {}),
  })

  scanned += result.docs.length

  for (const doc of result.docs) {
    const isRaster = doc.mimeType?.startsWith('image/') && doc.mimeType !== 'image/svg+xml'
    if (!doc.filename || !isRaster) continue
    if (doc.blurDataURL && !FORCE) continue

    if (LIMIT > 0 && todo >= LIMIT) {
      payload.logger.info(`LIMIT ${LIMIT} reached — run again for the next batch`)
      break pages
    }
    todo++

    if (!APPLY) {
      payload.logger.info(`  would fill ${doc.filename}`)
      continue
    }

    try {
      // Thumbnail first (small, same aspect ratio — it has no crop), the original as fallback.
      const name = doc.sizes?.thumbnail?.filename || doc.filename
      const response = await fetch(`${MEDIA_SOURCE}/api/media/file/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`fetch ${response.status}`)

      const blur = await makeBlurDataURL(Buffer.from(await response.arrayBuffer()), doc.mimeType)

      if (!blur) {
        // Transparent or unreadable: stays without blur (the photo loads over the card grey).
        notApplicable++
        payload.logger.info(`  ${doc.filename}: no blur (transparent or not readable)`)
      } else {
        await payload.db.updateOne({
          collection: 'media',
          id: doc.id,
          data: { blurDataURL: blur },
          returning: false,
        })
        written++
        payload.logger.info(`  ${doc.filename}: ${blur.length} chars`)
      }
    } catch (error) {
      failed++
      payload.logger.error(`  ${doc.filename}: FAILED — ${(error as Error).message}`)
    }

    if (PAUSE_MS > 0) await sleep(PAUSE_MS)
  }

  if (!result.hasNextPage) break
}

payload.logger.info(
  `${scanned} media documents scanned, ${todo} without blur` +
    (APPLY ? ` → ${written} filled, ${notApplicable} not applicable, ${failed} failed` : ''),
)

process.exit(failed > 0 ? 1 : 0)
