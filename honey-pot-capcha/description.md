# ALTCHA und Honeypot in Payload-Formularen

Öffentliche Formulare lassen sich mit einem **Honeypot** (verstecktes Feld) und **ALTCHA** (Proof-of-Work-Challenge) absichern. Die Prüfung erfolgt in **Server Actions** vor dem Schreiben in Payload. Importpfade (z. B. zu Hilfsfunktionen) musst du in deinem Zielprojekt anpassen.

**Abhängigkeiten (Beispiel):** `altcha`, `altcha-lib` — sowie ein Framework mit Server Actions und einer HTTP-Route für Challenges (hier Next.js App Router).

---

## Umgebungsvariable

| Variable          | Bedeutung                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTCHA_HMAC_KEY` | Geheimer Schlüssel (z. B. zufällige Zeichenkette, 32+ Zeichen). Ohne Key schlägt die Verifizierung fehl; die Challenge-Route sollte mit Fehler antworten. |

---

## Challenge-Route (GET)

Erzeugt eine signierte Challenge; der Browser-Widget ruft diese URL ab.

```typescript
import { createChallenge } from "altcha-lib";
import { NextResponse } from "next/server";

const hmacKey = process.env.ALTCHA_HMAC_KEY;

export async function GET() {
  if (!hmacKey) {
    return NextResponse.json(
      { error: "ALTCHA not configured" },
      { status: 500 },
    );
  }

  const challenge = await createChallenge({
    hmacKey,
    maxNumber: 100000,
    expires: new Date(Date.now() + 5 * 60 * 1000),
  });

  return NextResponse.json(challenge);
}
```

`challengeurl` im Widget muss zu dieser Route passen (hier z. B. `/api/altcha`).

---

## Gemeinsame Hilfsfunktionen (Server)

```typescript
import { verifySolution } from "altcha-lib";

const hmacKey = process.env.ALTCHA_HMAC_KEY;

const consumedPayloads = new Map<string, number>();
const CONSUMED_TTL = 5 * 60 * 1000;

function cleanupConsumedPayloads() {
  const now = Date.now();
  for (const [key, timestamp] of consumedPayloads) {
    if (now - timestamp > CONSUMED_TTL) {
      consumedPayloads.delete(key);
    }
  }
}

export async function verifyAltcha(payload: string | null): Promise<boolean> {
  const trimmed = typeof payload === "string" ? payload.trim() : "";
  if (!hmacKey) {
    if (process.env.NODE_ENV === "development") {
      console.error("[ALTCHA] ALTCHA_HMAC_KEY fehlt.");
    }
    return false;
  }
  if (!trimmed) return false;

  cleanupConsumedPayloads();

  if (consumedPayloads.has(trimmed)) {
    return false;
  }

  try {
    return await verifySolution(trimmed, hmacKey);
  } catch {
    return false;
  }
}

export function markAltchaPayloadConsumed(payload: string | null): void {
  const trimmed = typeof payload === "string" ? payload.trim() : "";
  if (!trimmed) return;
  consumedPayloads.set(trimmed, Date.now());
}

export function isHoneypotFilled(formData: FormData): boolean {
  const value = formData.get("contact_time");
  return typeof value === "string" && value.length > 0;
}
```

Hinweis: Die Map lebt im Speicher der einen Node-Prozesses — bei horizontaler Skalierung ggf. durch geteilten Store ersetzen.

---

## Komponente: Honeypot

Feldname **`contact_time`** muss zu `isHoneypotFilled` passen.

```tsx
import React from "react";

export const Honeypot: React.FC = () => (
  <div
    aria-hidden="true"
    className="absolute overflow-hidden"
    style={{ left: "-9999px" }}
  >
    <input
      type="text"
      name="contact_time"
      tabIndex={-1}
      autoComplete="off"
      defaultValue=""
    />
  </div>
);
```

Das umgebende `<form>` sollte `position: relative` haben, damit die absolute Positionierung des Wrappers passt.

---

## Komponente: AltchaWidget (Client)

```tsx
"use client";

import React, { useEffect, useRef } from "react";

type AltchaWidgetProps = {
  className?: string;
  auto?: "off" | "onfocus" | "onload" | "onsubmit";
};

export const AltchaWidget: React.FC<AltchaWidgetProps> = ({
  className: _className,
  auto = "onsubmit",
}) => {
  const widgetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    import("altcha");
  }, []);

  return (
    <altcha-widget
      ref={widgetRef}
      challengeurl="/api/altcha"
      auto={auto}
      style={{ display: "none" }}
    />
  );
};
```

- **`auto="onsubmit"` (Standard):** Challenge beim Absenden — gut für einfache HTML-Formulare.
- **`auto="onload"`:** Challenge früh starten — sinnvoll bei `react-hook-form` oder wenn du vor dem Fetch explizit `verify()` aufrufest.

Das Web Component trägt die Lösung als Formularfeld **`altcha`** in `FormData` ein (wenn das Widget im `<form>` liegt).

---

## Variante A: Generischer Form-Builder (react-hook-form)

**Idee:** Dynamische Felder, Submit baut `FormData` aus dem DOM-Formular, setzt `altcha` explizit und schickt Metadaten (z. B. `formId`, JSON der Werte) an die Server Action.

**JSX-Ausschnitt im Formular:**

```tsx
<form ref={formRef} className="relative" onSubmit={handleSubmit(onSubmit)}>
  <Honeypot />
  {/* … dynamische Felder … */}
  <AltchaWidget auto="onload" />
  <button type="submit">Senden</button>
</form>
```

**Client: `verified`-Event und Payload-Ref**

```tsx
const formRef = useRef<HTMLFormElement>(null);
const altchaPayloadRef = useRef<string | null>(null);

useEffect(
  () => {
    const form = formRef.current;
    if (!form) return;
    const widget = form.querySelector("altcha-widget");
    if (!widget) return;

    const onVerified = (e: Event) => {
      const detail = (e as CustomEvent<{ payload?: string }>).detail;
      altchaPayloadRef.current = detail?.payload ?? null;
    };

    widget.addEventListener("verified", onVerified);
    return () => widget.removeEventListener("verified", onVerified);
  },
  [
    /* deps: z. B. Formular-ID / Felderanzahl */
  ],
);
```

**Client: vor dem Aufruf der Server Action**

```tsx
const formEl = formRef.current;
if (!formEl) return;

const formData = new FormData(formEl);

const widget = formEl.querySelector("altcha-widget") as
  | (HTMLElement & { getState?: () => string; verify?: () => Promise<void> })
  | null;

let altchaPayload = altchaPayloadRef.current?.trim() || null;

if (!altchaPayload && widget && typeof widget.verify === "function") {
  try {
    await widget.verify();
    await new Promise<void>((r) => queueMicrotask(() => r()));
    altchaPayload = altchaPayloadRef.current?.trim() || null;
  } catch {
    // Fehler anzeigen
    return;
  }
}

if (!altchaPayload) {
  // Fehler anzeigen
  return;
}

formData.set("altcha", altchaPayload);
// formData.set('formId', …)
// formData.set('submissionJson', …)

const result = await submitFormBuilderForm(formData);
```

Nach fehlgeschlagenem Submit: `altchaPayloadRef.current = null` und ggf. erneut `widget.verify()`.

**Server Action (Muster — Collection und Feldnamen anpassen):**

```typescript
"use server";

import { getPayload } from "payload";
import configPromise from "@payload-config";
import {
  isHoneypotFilled,
  markAltchaPayloadConsumed,
  verifyAltcha,
} from "./altcha";

export async function submitFormBuilderForm(formData: FormData) {
  if (isHoneypotFilled(formData)) {
    return { success: true };
  }

  const altchaPayload = formData.get("altcha") as string | null;
  if (!(await verifyAltcha(altchaPayload))) {
    return {
      success: false,
      error: "Verifizierung fehlgeschlagen. Bitte versuchen Sie es erneut.",
    };
  }

  // … formId, submissionJson parsen, validieren …

  const payload = await getPayload({ config: configPromise });

  await payload.create({
    collection: "form-submissions",
    data: {
      /* form, submissionData, … */
    },
    overrideAccess: true,
  });

  markAltchaPayloadConsumed(altchaPayload);
  return { success: true };
}
```

---

## Variante B: Festes Kontaktformular ( natives Submit )

**Idee:** Ein `<form>`, `FormData(event.currentTarget)`, keine Ref-Logik für ALTCHA nötig, wenn `auto="onsubmit"` ausreicht.

**JSX-Ausschnitt:**

```tsx
<form onSubmit={handleSubmit}>
  <Honeypot />
  {/* … Felder … */}
  <AltchaWidget />
  <button type="submit">Nachricht senden</button>
</form>
```

**Submit-Handler (Kurzfassung):**

```tsx
const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const formData = new FormData(form);
  startTransition(async () => {
    const result = await submitKontaktForm(formData);
    // …
  });
};
```

**Server Action (Muster — Validierung und Collection anpassen):**

```typescript
"use server";

import { getPayload } from "payload";
import configPromise from "@payload-config";
import {
  isHoneypotFilled,
  markAltchaPayloadConsumed,
  verifyAltcha,
} from "./altcha";

export async function submitKontaktForm(formData: FormData) {
  if (isHoneypotFilled(formData)) {
    return { success: true };
  }

  const altchaPayload = formData.get("altcha") as string | null;
  if (!(await verifyAltcha(altchaPayload))) {
    return {
      success: false,
      error: "Verifizierung fehlgeschlagen. Bitte versuchen Sie es erneut.",
    };
  }

  // … Felder aus formData lesen und validieren …

  const payload = await getPayload({ config: configPromise });

  await payload.create({
    collection: "kontaktSubmissions",
    overrideAccess: true,
    data: {
      /* … */
    },
  });

  markAltchaPayloadConsumed(altchaPayload);
  return { success: true };
}
```

---

## Reihenfolge in Server Actions (immer gleich)

1. **`isHoneypotFilled`** → bei Treffer **`{ success: true }`** zurückgeben (Bot merkt nicht, dass er gefiltert wurde).
2. **`verifyAltcha(formData.get('altcha'))`** → bei Fehler klare Nutzermeldung.
3. Eigene Validierung und **`payload.create`**.
4. Nur nach erfolgreichem Speichern: **`markAltchaPayloadConsumed(altchaPayload)`**.

---

## Checkliste für weitere Formulare

1. `Honeypot` im `<form>`; Name `contact_time` oder Hilfsfunktion anpassen.
2. `AltchaWidget` im `<form>`; bei komplexem Client ggf. `auto="onload"` und `verified` / `verify()` wie in Variante A.
3. Server Action: Honeypot → ALTCHA → Logik → `markAltchaPayloadConsumed`.
4. `ALTCHA_HMAC_KEY` in jeder Umgebung setzen.
