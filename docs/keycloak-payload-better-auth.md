# Keycloak + Payload CMS + Better Auth (Next.js) — Checkliste

Kompakte **Checkliste** pro neuer Site / neuer öffentlicher URL. Ausführlicher Ablauf, Code und Varianten: [`../keycloak/description.md`](../keycloak/description.md).

## Praxis vor dem ersten Login

1. Schnellstart-Tabelle unten mit der echten **`ORIGIN`** durchgehen.
2. Falls vorhanden: `GET /api/auth-redirect-uris` (nur nicht-produktiv) mit Keycloak **Valid redirect URIs** abgleichen.
3. **Valid post logout redirect URIs** mit dem Pfad abgleichen, den **Logout-Button** / Frontend wirklich sendet (`/admin` vs. `/admin/login` vs. `/`).

## Schnellstart: Keycloak für eine neue Site / neue URL

Für **jede** öffentliche Basis-URL (lokal, Preview, Production) dieselben Schritte — nur `ORIGIN` austauschen.

| Schritt | Wo in Keycloak | Was eintragen |
|--------|----------------|----------------|
| 1 | Realm wählen | z. B. `northlight` — **Issuer** notieren: `https://<host>/realms/<realm>` |
| 2 | Client anlegen (confidential empfohlen) | Client-ID z. B. `brandportal-cms` oder `projektname-cms` |
| 3 | **Valid redirect URIs** | `ORIGIN/api/auth/oauth2/callback/<providerId>` — **exakt**, kein trailing slash auf dem Callback-Pfad |
| 4 | **Valid post logout redirect URIs** | Genau die URL, die die App als `post_logout_redirect_uri` sendet (z. B. `ORIGIN/admin`) |
| 5 | Web origins (falls gefragt) | `ORIGIN` oder `+` je nach Keycloak-Version / Policy |
| 6 | Client authentication | Für confidential: Secret generieren → in `.env` als `KEYCLOAK_*_CLIENT_SECRET` |
| 7 | App `.env` | `NEXT_PUBLIC_SERVER_URL` = **dieselbe** `ORIGIN` wie im Browser; `KEYCLOAK_ISSUER` = Issuer aus Schritt 1 |

**`ORIGIN`** = Schema + Host + Port, **ohne** trailing slash (z. B. `http://localhost:3000`).

**Nicht** mischen: einmal `localhost`, einmal `127.0.0.1` — Cookies und Redirects brechen. Entweder überall `localhost` oder überall `127.0.0.1` **und** dieselben URIs in Keycloak.

**`providerId`** in Better Auth (Server + Client) = **letztes** Pfadsegment des Callbacks, z. B. `…/callback/brandportal-cms` → `providerId: 'brandportal-cms'`.

## Varianten (Kurz)

| | **A — zwei Clients (CMS + Website), „Login only“** | **B — ein Client (CMS), Auto-Provisioning** |
|--|---------------------------------------------------|---------------------------------------------|
| Keycloak | CMS-Client + Website-Client, getrennte Redirects | Ein Client; Keycloak steuert, wer den Client nutzen darf |
| Payload-User | Kein Auto-Provision; Zuordnung über `users` + E-Mail / `betterAuthUserId` | Strategy kann `payload.create` nach OAuth |
| CMS-Zugriff | Nur bei verknüpftem Account + CMS-`providerId` (Mongo-Account-Scan) | Gültige Session mit CMS-`providerId`; ggf. `realms` nur Anzeige |
| Referenz | Rtbrick | Brandportal |

## Logout-URL (Realm-Pfad erhalten)

Falsch: `new URL('/protocol/openid-connect/logout', issuer)` — der Pfad ersetzt oft den Realm-Pfad am Host-Root.

Richtig: Issuer normalisieren und den Logout-Pfad **anhängen**, plus `client_id` und `post_logout_redirect_uri` (exakt wie in Keycloak eingetragen).

Siehe Codebeispiel in [`keycloak/description.md`](../keycloak/description.md) (Abschnitt Keycloak Logout-URL).

## Umgebungsvariablen (überblick)

| Variable | Zweck |
|----------|--------|
| `NEXT_PUBLIC_SERVER_URL` | Öffentliche App-URL ohne trailing slash; Better Auth `baseURL` / Browser |
| `BETTER_AUTH_URL` | Optional, wenn OAuth-Basis von `NEXT_PUBLIC_SERVER_URL` abweicht |
| `KEYCLOAK_ISSUER` / `NEXT_PUBLIC_KEYCLOAK_ISSUER` | Realm-Issuer (Server / Browser für Logout) |
| `KEYCLOAK_CMS_CLIENT_ID` (+ Secret) | CMS-Client; für Logout oft `client_id` nötig |
| `KEYCLOAK_AUTH_SERVER_URL` + `KEYCLOAK_REALM` | Alternative zu `KEYCLOAK_ISSUER` |
| `BETTER_AUTH_SECRET` | ≥ 32 Zeichen; ideal getrennt von `PAYLOAD_SECRET` |
| `DATABASE_URI` | MongoDB (Payload + Better Auth; manche Projekte nennen das Feld `DATABASE_URL`) |

## Autorisierung: drei Ebenen (Kurz)

1. **Eingeloggt?** — Session vorhanden (Better Auth: `getSession` / `getBetterAuthSession`).
2. **App / Client?** — mindestens eine **Client Role** unter `resource_access[<clientId>].roles` (JWT/UserInfo/in Session gespiegelt — Better Auth liefert das nicht immer out-of-the-box).
3. **Aktion?** — z. B. `admin` / `editor` / `viewer` für feine UI- oder API-Checks.

**Trennung:** Keycloak = **drei Rollen** als Quelle für **Zugriff / Stufe auf der `users`-Collection** (Payload). **Restliche** CMS-Daten und Einstellungen in Payload von Admin/Editor pflegbar; **Editor** darf keine Admin-only-Bereiche ändern (konkrete Felder/Collections projektoffen). Details: [`../keycloak/description.md`](../keycloak/description.md) (Abschnitte *Autorisierung* und *Trennung*).

## Sicherheit (Kurz)

- Wer den CMS-Client in Keycloak nutzen darf = wer ins Admin kann (Variante B: zusätzlich Payload-Rollen).
- Redirect- und Post-Logout-URIs **eng** halten, keine großen Wildcards.
- `requireIssuerValidation` in Better Auth aktivieren, wenn der Issuer stabil ist.
