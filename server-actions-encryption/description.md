# „Failed to find Server Action" — stabiler Encryption Key

Fix für den wiederkehrenden Fehler auf self-hosted Next.js-/Payload-Deployments
(Dokploy/Hetzner):

```
[Error: Failed to find Server Action "x". This request might be from an older or newer deployment.]
```

## Ursache

Next.js **verschlüsselt die Closure-Variablen von Server Actions**, bevor sie an den
Client gehen. Der dafür genutzte Key wird **bei jedem `next build` neu zufällig
generiert**. Jeder Dokploy-Deploy = neuer Build = **neuer Key**.

Ein Client, der noch die **alte** Version offen hat (offener Tab, Redeploy während einer
Session, oder mehrere Instanzen mit unterschiedlichen Builds), schickt eine Action-ID,
die der neue Build **nicht mehr entschlüsseln** kann → genau dieser Fehler.

## Dev vs. Prod

- **Dev:** unvermeidbar und **harmlos**. HMR baut ständig neu, der Key ändert sich
  laufend, während der Browser noch alten Client-Code hält. Ignorieren.
- **Prod:** tritt bei **Redeploys**, **offenen Tabs** oder **mehreren Instanzen** auf.
  Hier ist ein **stabiler Key** die Lösung.

## Fix: `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`

Einen festen Key setzen, der über alle Builds gleich bleibt — base64, gültige AES-Länge
(16/24/**32** Byte; Next generiert per Default 32).

1. Einmalig generieren:
   ```bash
   openssl rand -base64 32
   ```
2. In Dokploy bei der **App → Environment** eintragen:
   ```env
   NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<generierter Wert>
   ```

**Wichtig:**
- Muss **beim Build** vorhanden sein — der Key wird ins Build-Output eingebettet und zur
  Laufzeit automatisch genutzt. In Dokploy ist die App-Environment beim Build verfügbar,
  passt also.
- Wie ein **Secret** behandeln: **nicht** `NEXT_PUBLIC_`, nicht ins Repo committen.
- Über **alle Instanzen** eines Projekts identisch halten.

## Optional: `deploymentId` (Version-Skew)

Fängt den „alter Tab nach Redeploy"-Fall zusätzlich sauber ab. Mit gesetztem
`deploymentId` erkennt Next.js einen Versions-Unterschied und macht einen **harten
Full-Reload** statt einer kaputten Client-Navigation (statt fehlender JS/CSS-Assets oder
Action-Mismatches).

**`next.config.js`:**
```js
module.exports = {
  deploymentId: process.env.DEPLOYMENT_VERSION, // z. B. Git-Hash
}
```
Nur Kür — der eigentliche Fix für *diesen* Fehler ist der Encryption Key oben.

## Checkliste

- [ ] `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` einmal via `openssl rand -base64 32` erzeugen.
- [ ] In Dokploy (App-Environment) als Secret hinterlegen — vor dem nächsten Build.
- [ ] Über alle Instanzen/Umgebungen desselben Projekts identisch halten.
- [ ] (Optional) `deploymentId` in `next.config.js` für Rolling-Deploys/alte Tabs.

## Quelle

[Next.js — Self-Hosting → Server Functions encryption key](https://nextjs.org/docs/app/guides/self-hosting)
