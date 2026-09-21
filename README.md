# Street Code

The automotive operating system for the Gambia: a vehicle's service countdowns, verified history, driver lending, and roadside checks for the police. One API, three front-ends.

| Surface | Path | For |
|---|---|---|
| Website | `/` | Buyers checking a car, garages, the public |
| Mobile app (installable PWA) | `/app/` | Owners, drivers, mechanics, garage bosses |
| Police Command | `/command/` | Officers and supervisors (provisioned by an administrator) |
| API | `/api/` | Everything above |

## Run it

```bash
npm run setup     # .env with fresh secrets, dependencies, demo database
npm run dev       # http://localhost:3000
npm test          # 34 engine tests + 67 API tests
```

Needs Node 22.13+ (the database is Node's built-in `node:sqlite`, which prints an "experimental" notice; that is expected).

Demo sign-ins (development only), password `streetcode`: Fatou the owner, Lamin who has been lent her car, Ebrima the garage owner, Modou the mechanic (employee at one garage, owner of another), Ousman the officer, Isatou the supervisor, an administrator. `GET /api/dev/accounts` lists the phone numbers.

## What is where

```
apps/api        Express API, SQLite, realtime hub, scheduler, tests
apps/mobile     the app (PWA, offline shell)
apps/command    police console
apps/web        public website
packages/core   the service engine, licence rules and roadside verdict (pure, shared by API and all apps)
packages/design tokens, components, 67 custom icons, brand assets (favicons, tiles, app icons)
prototypes/     your original prototypes, untouched
legacy/         the v1 code, kept for reference. Safe to delete once you are happy.
docs/           GAP-ANALYSIS.md, ARCHITECTURE.md
```

## Before real use

Read the "Needs a human decision" section of `docs/GAP-ANALYSIS.md`. In particular: the licence-group table, the fine schedule and the service-interval defaults are best public evidence, not official sources. In production the server refuses to start with default secrets.

Fonts (Oswald and IBM Plex) load from Google Fonts. To self-host them, put the `.woff2` files in `packages/design/fonts` and add `@font-face` rules; the fallback stacks work in the meantime.
