# payload-skills

Collection of practical checklists and implementation notes for **Payload CMS** with **Next.js** (media setup, security, auth, links, popups, tracking, and styling). Each topic lives in its own folder under `description.md`, except the short Keycloak quick reference in `docs/`.

## Markdown files

| Document | What it covers |
| -------- | -------------- |
| [payload-start/description.md](payload-start/description.md) | Checklist for bootstrapping a new Payload site: upload size limits, WebP output, Sharp resize rules, and related `payload.config.ts` / `Media` collection settings. |
| [security-check/description.md](security-check/description.md) | Pre-deployment security checklist for Next.js, Payload, and hosting: HTTP headers, env/secrets, CORS, rate limiting, file uploads, admin hardening, and infrastructure basics. |
| [tracking/description.md](tracking/description.md) | How GTM, tracking, and the cookie banner fit together: `c15t` consent manager, provider setup, categories, and central `pushTrackingEvent` behavior. |
| [docs/keycloak-payload-better-auth.md](docs/keycloak-payload-better-auth.md) | Compact Keycloak + Payload + Better Auth checklist: `ORIGIN`, redirect URIs, logout URLs, env vars, and high-level architecture variants (links to the long-form skill doc). |
| [keycloak/description.md](keycloak/description.md) | Full Keycloak integration guide for Next.js: client setup, Better Auth callbacks, strategies, logout URL construction, Payload admin access patterns, and code-oriented detail. |
| [advanced-link/description.md](advanced-link/description.md) | CMS link system: Payload `link()` / `linkGroup()`, Lexical rich-text links, `CMSLink`, internal docs vs custom URLs, and **action** links (e.g. newsletter popup via custom events). |
| [pop-up/description.md](pop-up/description.md) | Marketing popup and newsletter dialog: Payload globals (`popup`, `newsletterTexts`), layout wiring, Lenis, CMSLink actions, and the popup section block. |
| [northlight-global-css/description.md](northlight-global-css/description.md) | Placeholder heading for global CSS variables in the Northlight Payload template (extend this file when documenting tokens). |

## Folder layout

Each skill-style folder is named after the topic; open the linked `description.md` (or `docs/…`) for the full content.
