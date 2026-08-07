# Formulare, Bewerbungen und Mailversand — Pflichtsetup

Gilt für **jedes** Projekt mit öffentlichen Formularen (Kontakt, Bewerbung, Rückruf,
Angebotsanfrage). Vier Regeln, die von Anfang an stehen müssen — nachträglich nachrüsten
heißt in der Praxis: verlorene Bewerbungen und Lebensläufe unter einer öffentlichen URL.

1. **Jede Einsendung landet in einer Collection.** Die Mail ist die Benachrichtigung, nicht
   der Speicher. Ein Mailfehler darf keine Bewerbung vernichten.
2. **Dateien kommen nie in `media`.** Sie gehören in eine eigene Upload-Collection mit
   striktem `access.read` — `media` ist öffentlich lesbar und hängt am CDN/imgproxy.
3. **Die Dateien gehen immer mit der Mail raus.** Der Kunde soll Bewerbungsunterlagen im
   Postfach haben, ohne sich ins Admin einloggen zu müssen.
4. **Der Mailadapter ist env-gesteuert.** Default **Resend**, damit sofort etwas funktioniert;
   liefert der Kunde eigene Zugangsdaten (fast immer **SMTP**), wird nur die Env getauscht —
   kein Code-Change, kein Vergessen beim Go-Live.

Reihenfolge: **Todo 1** Mailadapter → **Todo 2** sichere Datei-Collection → **Todo 3**
Einsendungs-Collection → **Todo 4** Versand mit Anhang.

---

## Todo 1: Mailadapter — Resend als Default, Kunden-SMTP als Variante

**Dateien:** `src/email/adapter.ts`, `src/payload.config.ts`

Beide Adapter werden im Projekt installiert, die Auswahl passiert zur Laufzeit über die Env.
So ist der Wechsel auf den Kundenmailserver eine Env-Änderung in Dokploy, kein Deployment mit
Codeänderung — und niemand muss sich daran erinnern, dass es den zweiten Pfad gibt.

```bash
pnpm add @payloadcms/email-resend @payloadcms/email-nodemailer nodemailer
```

```ts
// src/email/adapter.ts
import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import { resendAdapter } from '@payloadcms/email-resend'
import nodemailer from 'nodemailer'

const defaultFromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@example.com'
const defaultFromName = process.env.EMAIL_FROM_NAME || 'Website'

export const emailAdapter = process.env.SMTP_HOST
  ? // Kundenvariante: eigener Mailserver / Postfach beim Hoster
    nodemailerAdapter({
      defaultFromAddress,
      defaultFromName,
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_PORT === '465', // 465 = implizites TLS, 587 = STARTTLS
        auth: {
          user: process.env.SMTP_USER!,
          pass: process.env.SMTP_PASSWORD!,
        },
      }),
    })
  : // Default: Resend
    resendAdapter({
      defaultFromAddress,
      defaultFromName,
      apiKey: process.env.RESEND_API_KEY || '',
    })
```

```ts
// src/payload.config.ts
import { emailAdapter } from './email/adapter'

export default buildConfig({
  email: emailAdapter,
  // …
})
```

### Umgebungsvariablen

| Variable | Zweck |
| -------- | ----- |
| `EMAIL_FROM_ADDRESS` | Absender — **immer** eine Adresse auf einer verifizierten eigenen Domain |
| `EMAIL_FROM_NAME` | Absendername (z. B. „Karriere – Musterfirma") |
| `EMAIL_NOTIFY_TO` | Empfänger der Benachrichtigung (Fallback, wenn im Formular nichts hinterlegt ist) |
| `RESEND_API_KEY` | Default-Pfad; ohne Key verschickt Payload nichts und loggt nur |
| `SMTP_HOST` | **Schalter:** gesetzt → Nodemailer statt Resend |
| `SMTP_PORT` | 587 (STARTTLS) oder 465 (implizites TLS) |
| `SMTP_USER` / `SMTP_PASSWORD` | Zugangsdaten des Kundenpostfachs — nie ins Repo, nie `NEXT_PUBLIC_*` |

### Absender, SPF/DKIM/DMARC

- **From ist nie die Adresse des Absenders des Formulars.** Wer `from: bewerber@gmx.at` setzt,
  fliegt bei DMARC raus. Absender ist die Projektdomain, die Bewerberadresse kommt in
  **`replyTo`** — dann funktioniert „Antworten" im Postfach des Kunden trotzdem.
- **Resend:** Domain im Resend-Dashboard verifizieren (SPF + DKIM als DNS-Records), sonst
  landet alles im Spam. Ohne verifizierte Domain geht nur die Resend-Testadresse — die ist
  kein Go-Live-Zustand.
- **Kunden-SMTP:** vor dem Go-Live eine echte Testmail verschicken und im Header prüfen, ob
  SPF/DKIM `pass` liefern.

### Testmails gehen an northlight.at — nicht an den Kunden

**Empfänger jeder Testmail ist eine `@northlight.at`-Adresse**, auch wenn `EMAIL_NOTIFY_TO`
in der Produktion längst auf das Kundenpostfach zeigt. Beim Testen für den Durchlauf
umstellen (bzw. `to:` im Testskript hart setzen) und erst nach bestandenem Test auf die
Kundenadresse zurückdrehen. Zwei Gründe:

- **Der Kunde bekommt keine Testbewerbungen ins Postfach.** „Max Mustermann, Lebenslauf.pdf"
  in der Karriere-Inbox erzeugt genau die Rückfragen, die niemand braucht — und im Zweifel
  antwortet jemand darauf.
- **Die Adresse liegt außerhalb der Sendedomäne.** Genau dafür ist der Test da: Läuft die
  Mail über die Kundendomäne und landet im Postfach derselben Domäne, wird intern zugestellt
  und SPF/DKIM/DMARC werden gar nicht erst bewertet — der Test sagt dann nichts aus.

Im Rohtext der empfangenen Mail (`Authentication-Results`) müssen `spf=pass` und `dkim=pass`
stehen. Mit Anhang testen, nicht nur mit einer leeren Nachricht.

### Kundenfrage im Kickoff

Zwei Zeilen ins Onboarding-Protokoll, damit das nicht im Go-Live-Stress hochkommt:

- „Sollen Formularmails über unseren Dienst (Resend) laufen oder über euren Mailserver?"
- Bei „unser Mailserver": Host, Port, Benutzer, Passwort, Absenderadresse — und wer die
  DNS-Records der Domain verwaltet.

Kommt keine Antwort, bleibt Resend aktiv. Das ist der Grund für den Default: Es funktioniert
immer etwas, und der Wechsel bleibt jederzeit möglich.

---

## Todo 2: Sichere Datei-Collection — niemals `media`

**Datei:** `src/collections/SecureDocuments.ts`

`media` hat `read: () => true`, hängt an imgproxy/CDN und wird von Sharp durch die
WebP-Varianten geschickt. Ein Lebenslauf dort ist ein öffentlich abrufbares, gecachtes PDF —
auch nach dem Löschen im Admin noch eine Weile über den CDN-Cache erreichbar.

```ts
// src/collections/SecureDocuments.ts
import type { CollectionConfig } from 'payload'

export const SecureDocuments: CollectionConfig = {
  slug: 'secure-documents',
  admin: {
    group: 'Einsendungen',
    hidden: ({ user }) => user?.role !== 'admin', // optional
  },
  access: {
    // Kein öffentlicher Zugriff — weder API noch Datei-URL.
    read: ({ req: { user } }) => Boolean(user),
    create: () => false, // nur aus der Server Action mit overrideAccess: true
    update: () => false,
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
  upload: {
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    // Keine imageSizes, keine formatOptions: Bewerbungsunterlagen werden nicht
    // in WebP-Varianten zerlegt — jede Variante wäre eine weitere Datei-URL.
  },
  fields: [
    { name: 'submission', type: 'relationship', relationTo: 'applications', admin: { readOnly: true } },
  ],
}
```

**S3-Anbindung** (siehe [payload-start Todo 2](../payload-start/description.md)) — eigener
Prefix, und **`disablePayloadAccessControl` bleibt aus**, sonst hängt die Datei an einer
öffentlichen CDN-URL und `access.read` greift nicht mehr:

```ts
s3Storage({
  collections: {
    media: true,
    'secure-documents': { prefix: 'secure' }, // kein disablePayloadAccessControl!
  },
  // …
})
```

**Form-Builder:** Wer `@payloadcms/plugin-form-builder` mit dem `upload`-Feldtyp nutzt, muss
`uploadCollections` auf die sichere Collection zeigen lassen — der naheliegende Default ist
`media` und damit falsch:

```ts
formBuilderPlugin({
  fields: {
    upload: { uploadCollections: ['secure-documents'] }, // nicht 'media'
  },
})
```

**Abnahmetest** (gehört in die [Security-Checkliste](../security-check/description.md)):
Datei-URL aus dem Admin kopieren, in **Inkognito** oder per `curl` ohne Cookies aufrufen →
muss **403/404** liefern. Zusätzlich prüfen, dass die Datei nicht im Bucket öffentlich
gelistet ist.

---

## Todo 3: Einsendungs-Collection — die Mail ist nicht der Speicher

**Datei:** `src/collections/Applications.ts` (analog für Kontaktanfragen)

Für generische Formulare reicht `form-submissions` aus dem Form-Builder. Für **Bewerbungen**
lohnt eine eigene Collection: eigene Felder, eigener Status, eigene Löschfrist, eigener
Zugriff (HR sieht Bewerbungen, Redaktion nicht).

```ts
import type { CollectionConfig } from 'payload'

export const Applications: CollectionConfig = {
  slug: 'applications',
  admin: {
    group: 'Einsendungen',
    useAsTitle: 'email',
    defaultColumns: ['email', 'position', 'status', 'mailStatus', 'createdAt'],
  },
  access: {
    read: ({ req: { user } }) => Boolean(user),
    create: () => false, // nur Server Action, overrideAccess: true
    update: ({ req: { user } }) => Boolean(user),
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
  fields: [
    { name: 'position', type: 'relationship', relationTo: 'jobs' },
    { name: 'firstName', type: 'text', required: true },
    { name: 'lastName', type: 'text', required: true },
    { name: 'email', type: 'email', required: true },
    { name: 'phone', type: 'text' },
    { name: 'message', type: 'textarea' },
    {
      name: 'documents',
      type: 'relationship',
      relationTo: 'secure-documents',
      hasMany: true,
      admin: { readOnly: true },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'new',
      options: ['new', 'in-review', 'done'],
    },
    {
      name: 'mailStatus',
      type: 'select',
      defaultValue: 'pending',
      options: ['pending', 'sent', 'failed'],
      admin: { readOnly: true, description: 'Status der Benachrichtigungsmail' },
    },
    { name: 'mailError', type: 'text', admin: { readOnly: true, condition: (d) => d?.mailStatus === 'failed' } },
  ],
}
```

`mailStatus` ist kein Luxus: Ohne dieses Feld merkt niemand, dass der SMTP-Server des Kunden
seit drei Wochen ablehnt — die Einsendungen liegen dann zwar in der DB, aber ungelesen.

**Löschkonzept** mit dem Kunden festhalten (Bewerbungsunterlagen werden üblicherweise nach
einigen Monaten gelöscht; die konkrete Frist ist eine Frage an die Rechtsabteilung des
Kunden, nicht an uns). Umsetzung: ein Job/Cron, der alte `applications` samt zugehöriger
`secure-documents` löscht — Dokumente zuerst, sonst bleiben Waisen im Bucket.

---

## Todo 4: Versand — Datei einmal einlesen, zweimal verwenden

**Datei:** `src/actions/submitApplication.ts` (Server Action, siehe
[honey-pot-capcha](../honey-pot-capcha/description.md) für Honeypot + ALTCHA davor)

Der Buffer aus dem Upload wird **einmal** gelesen und dann sowohl in die sichere Collection
geschrieben als auch an die Mail gehängt. Kein zweiter Download aus S3, keine Race Condition.

```ts
'use server'

import configPromise from '@payload-config'
import { getPayload } from 'payload'

// Nodemailer wertet `encoding` aus, Resend erwartet `content` ohnehin als Base64 —
// dieses Format funktioniert in beiden Adaptern.
const toAttachment = (file: File, buffer: Buffer) => ({
  filename: file.name,
  content: buffer.toString('base64'),
  encoding: 'base64' as const,
  contentType: file.type || 'application/octet-stream',
})

export async function submitApplication(formData: FormData) {
  // … Honeypot, ALTCHA, Zod-Validierung …

  const payload = await getPayload({ config: configPromise })
  const files = formData.getAll('documents').filter((f): f is File => f instanceof File && f.size > 0)

  // 1) Dateien einlesen (einmal) und in die sichere Collection schreiben
  const attachments = []
  const documentIds = []

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer())

    const doc = await payload.create({
      collection: 'secure-documents',
      data: {},
      file: { data: buffer, name: file.name, mimetype: file.type, size: file.size },
      overrideAccess: true,
    })

    documentIds.push(doc.id)
    attachments.push(toAttachment(file, buffer))
  }

  // 2) Einsendung speichern — passiert VOR dem Mailversand
  const application = await payload.create({
    collection: 'applications',
    data: { /* … */ documents: documentIds, mailStatus: 'pending' },
    overrideAccess: true,
  })

  // 3) Benachrichtigung mit Anhängen — ein Fehler hier verliert nichts mehr
  try {
    await payload.sendEmail({
      to: process.env.EMAIL_NOTIFY_TO,
      replyTo: String(formData.get('email')), // Absender bleibt die eigene Domain
      subject: `Neue Bewerbung: ${formData.get('firstName')} ${formData.get('lastName')}`,
      html: '…',
      attachments,
    })

    await payload.update({
      collection: 'applications', id: application.id,
      data: { mailStatus: 'sent' }, overrideAccess: true,
    })
  } catch (error) {
    payload.logger.error({ err: error, msg: 'Bewerbungsmail fehlgeschlagen' })
    await payload.update({
      collection: 'applications', id: application.id,
      data: { mailStatus: 'failed', mailError: String(error) }, overrideAccess: true,
    })
  }

  return { success: true }
}
```

### Größenlimits

**Resend deckelt die gesamte Mail bei 40 MB — nach Base64-Kodierung**, das sind rund 30 MB
Rohdaten. Klassische SMTP-Postfächer liegen deutlich darunter (oft 10–25 MB). Deshalb:

- **Upload-Limit pro Datei** setzen (`upload.limits.fileSize`, siehe
  [payload-start Todo 1](../payload-start/description.md)) und im Frontend validieren —
  5 MB pro Datei sind für Bewerbungsunterlagen reichlich.
- **Gesamtgröße prüfen**, bevor die Mail rausgeht. Über dem Limit: Mail ohne Anhang
  verschicken, dafür mit Admin-Link auf die Einsendung — und das im Mailtext benennen,
  statt still einen Anhang wegzulassen.
- Die Einsendung ist ohnehin in der DB; der Anhang ist Komfort, nicht die Ablage.

### Nachträglich versenden (Datei liegt schon in S3)

Wenn die Datei über den Form-Builder-Upload kam oder eine Mail wiederholt werden soll, liegt
kein Buffer mehr vor. Dann über den S3-Client nachladen — **nicht** über die öffentliche
Datei-URL, die soll ja gerade nicht funktionieren:

```ts
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  region: process.env.S3_REGION!,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
})

const res = await s3.send(new GetObjectCommand({
  Bucket: process.env.S3_BUCKET!,
  Key: `secure/${doc.filename}`, // Prefix aus der s3Storage-Konfiguration
}))

const buffer = Buffer.from(await res.Body!.transformToByteArray())
```

---

## Checkliste

- [ ] `email:` in `payload.config.ts` gesetzt — Resend als Default, `SMTP_HOST` schaltet auf
      Nodemailer um.
- [ ] Kunde im Kickoff nach eigenem Mailserver gefragt; Antwort im Projektprotokoll.
- [ ] Absenderdomain verifiziert (SPF + DKIM), `spf=pass` / `dkim=pass` im Header der
      empfangenen Testmail geprüft.
- [ ] Testmails an eine **`@northlight.at`-Adresse**, nie an den Kunden — und nach dem Test
      `EMAIL_NOTIFY_TO` wieder auf die Kundenadresse gestellt.
- [ ] `replyTo` = Adresse aus dem Formular, `from` = eigene Domain.
- [ ] Beide Adapter einmal gegengetestet — inklusive Anhang.
- [ ] Eigene Collection für Einsendungen (`applications` / `form-submissions`), `create`
      nur über Server Action mit `overrideAccess`.
- [ ] `mailStatus` + `mailError` im Admin sichtbar.
- [ ] Dateien in `secure-documents`, **nicht** in `media`; `mimeTypes` eingeschränkt.
- [ ] Form-Builder `upload.uploadCollections` zeigt nicht auf `media`.
- [ ] `disablePayloadAccessControl` für die sichere Collection **nicht** gesetzt.
- [ ] Datei-URL in Inkognito/`curl` ohne Session getestet → 403/404.
- [ ] Anhänge kommen in der Testmail tatsächlich an; Gesamtgröße unter dem Limit des
      aktiven Adapters.
- [ ] Löschfrist für Bewerbungsunterlagen mit dem Kunden geklärt und als Job umgesetzt
      (Dokumente vor der Einsendung löschen).
