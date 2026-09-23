#!/usr/bin/env node
/**
 * Gleicht die Media-Dokumente gegen den S3-Bucket ab.
 *
 *   pnpm check:media            # nur Befunde
 *   pnpm check:media --alle     # auch die Varianten einzeln auflisten
 *
 * Warum es das gibt: Ein Upload kann ein Media-Dokument anlegen, ohne dass die
 * Datei im Bucket landet — ohne Fehlermeldung. Im Admin sieht das Dokument
 * einwandfrei aus, die Seite liefert fuer das Bild einen 404. Beobachtet am
 * 23.09.2026 in diesem Projekt: von drei Uploads eines Skripts kam nur der erste
 * an, Hauptdatei und alle Varianten der uebrigen fehlten. Ursache offen, in der
 * Wiederholung nicht mehr ausloesbar.
 *
 * Exit 1, sobald eine Datei fehlt — damit taugt es als Gate vor dem Go-live.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const zeigeAlle = process.argv.includes('--alle')

// @aws-sdk/client-s3 liegt als transitive Abhaengigkeit von @payloadcms/storage-s3
// im pnpm-Store und ist vom Projektwurzelverzeichnis aus nicht aufloesbar.
const pnpmDir = 'node_modules/.pnpm'
const sdkDir = existsSync(pnpmDir)
  ? readdirSync(pnpmDir).find((d) => d.startsWith('@aws-sdk+client-s3@'))
  : null
if (!sdkDir) {
  console.error('[media] @aws-sdk/client-s3 nicht gefunden. pnpm install?')
  process.exit(1)
}
const req = createRequire(
  join(process.cwd(), pnpmDir, sdkDir, 'node_modules/@aws-sdk/client-s3/package.json'),
)
const { HeadObjectCommand, S3Client } = req('@aws-sdk/client-s3')

const { getPayload } = await import('payload')
const config = (await import('@payload-config')).default

for (const v of ['S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
  if (!process.env[v]) {
    console.error(`[media] ${v} fehlt. Mit \`infisical run --env=dev -- pnpm check:media\` starten.`)
    process.exit(1)
  }
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
})

/**
 * Ein frisch geschriebenes Objekt ist nicht sofort sichtbar. Im Normalbetrieb
 * gemessen: 25–90 ms. Unter Last deutlich mehr — nach einem Import waren
 * Dateien 400 ms danach noch nicht auffindbar und Sekunden spaeter da.
 *
 * Ohne Wiederholung meldet dieses Skript deshalb nach jedem groesseren Import
 * Dateien als fehlend, die einfach nur unterwegs sind. Ein Detektor, der
 * regelmaessig falsch Alarm schlaegt, wird ignoriert — und dann faengt er den
 * echten Fall auch nicht mehr.
 */
const WARTEN_MS = [0, 500, 1500, 3000]

const vorhanden = async (key) => {
  for (const warten of WARTEN_MS) {
    if (warten) await new Promise((r) => setTimeout(r, warten))
    try {
      await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }))
      return true
    } catch {
      // weiter zum naechsten Versuch
    }
  }
  return false
}

const payload = await getPayload({ config })
const { docs } = await payload.find({
  collection: 'media',
  depth: 0,
  limit: 0,
  pagination: false,
  overrideAccess: true,
})

console.log(`${docs.length} Media-Dokumente werden gegen Bucket "${process.env.S3_BUCKET}" geprueft.\n`)

let kaputt = 0
let dateien = 0

for (const doc of docs) {
  const zuPruefen = [{ label: 'Hauptdatei', key: doc.filename }]
  for (const [name, groesse] of Object.entries(doc.sizes || {})) {
    if (groesse?.filename) zuPruefen.push({ label: name, key: groesse.filename })
  }

  const fehlend = []
  for (const { label, key } of zuPruefen) {
    dateien++
    if (!(await vorhanden(key))) fehlend.push(`${label} (${key})`)
  }

  if (fehlend.length) {
    kaputt++
    console.log(`FEHLT  ${doc.filename}  [${doc.id}]`)
    for (const f of fehlend) console.log(`         - ${f}`)
  } else if (zeigeAlle) {
    console.log(`ok     ${doc.filename}  (${zuPruefen.length} Dateien)`)
  }
}

console.log(`\n${dateien} Dateien geprueft, ${kaputt} Dokumente mit fehlenden Dateien.`)
if (kaputt) {
  console.log(
    `(Jede Datei wurde ueber ${WARTEN_MS.length} Versuche bis ${WARTEN_MS.reduce((a, b) => a + b, 0) / 1000}s gesucht.)`,
  )
}

if (kaputt) {
  console.error(
    '\nBetroffene Dokumente im Admin neu hochladen. Ein Dokument ohne Datei sieht dort\n' +
      'einwandfrei aus und liefert auf der Seite einen 404.',
  )
  process.exit(1)
}
process.exit(0)
