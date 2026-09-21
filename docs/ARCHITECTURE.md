# Architecture

## One person, many roles

There is no "role" on a user. What someone can do comes from three places:

- **Memberships**: a person's place in an organisation (garage, fleet, police station, car wash), by ownership, employment or contract. Roles have ranks: owner > manager > supervisor > mechanic > attendant > officer > driver. Nobody can add, promote or manage someone at or above their own rank, and the last owner cannot leave.
- **Ownership** of a vehicle (or management of the fleet that owns it).
- **Authorisations**: "Fatou may drive my Corolla from Friday to Sunday". Time-boxed, revocable mid-journey.

Memberships are loaded on every request, so suspending someone takes effect on their next call. Police and administrators are provisioned by an administrator; there is no self-service path.

## Who can touch a vehicle

| Caller | View | Odometer | Log service | Seal into passport | Lend | Report stolen |
|---|---|---|---|---|---|---|
| Owner or fleet manager | yes | yes | self-reported only | no | yes | yes (unconfirmed until police confirm) |
| Driver (lent, or fleet driver) | yes | yes | no | no | no | no |
| Garage staff | only with an owner-approved open job | yes | via job completion | yes (verified garage, mechanic or manager) | no | no |
| Police | via the check endpoint only | no | no | police clearance | no | flags |
| Stranger | public check: history and flag status, no personal data | no | no | no | no | no |

## The service engine (`packages/core`)

Pure functions, no clock and no I/O, shared by the API (alerts, verdicts) and every app (the bars). For each item: progress is the larger of distance used over the distance interval and time used over the time interval. The finish line is the due odometer and the earlier of the two projected due dates. Usage per day is learned from odometer readings (falling back to a typical value until there is enough data). Colours come from one scale (`gaugeColor`) so every bar agrees.

## The passport

Each event is a block: canonical JSON, SHA-256 hashed with the previous block's hash, signed with Ed25519. The database refuses UPDATE and DELETE on the table, and the API has no generic write. Only the workflow that owns an event type can create it (a garage completing a job, the flag workflow, the transfer handshake). Verification recomputes every hash and signature and checks the odometer never falls.

## The roadside check

`POST /api/police/check` resolves the vehicle, finds the active drive session (who declared they are driving, and whether that is the owner, a fleet driver, or someone the owner authorised), checks their licence covers the vehicle class, applies documents and open citations, and applies flags. Only flags in force take part: an unapproved person flag never does. The whole verdict is built by a pure function in `packages/core/src/verdict.js`. The check is logged by the server before the response is returned.

## Realtime and alerts

A WebSocket must authenticate with a first message. Users receive their own notifications; officers also receive flag and sighting events. A scheduler (every 15 minutes) turns service thresholds, document dates, ended authorisations, expiring flags and licence expiry into notifications, each with a dedupe key so nothing is sent twice.

## Production checklist

- `NODE_ENV=production`, and set `JWT_SECRET`, `LICENCE_CODE_KEY`, `MOMO_WEBHOOK_SECRET` (24+ characters each), `PASSPORT_PRIVATE_KEY_PEM`, `MOMO_MODE=live`. The server refuses to start otherwise.
- Keep the passport private key safe and backed up: losing it means old blocks can no longer be verified. Rotation needs a key registry (not built).
- Serve over HTTPS behind a proxy and set `TRUST_PROXY`. Back up `DATA_DIR` (the SQLite file is WAL-mode; use `.backup` or a filesystem snapshot).
- The rate limiter and lockout are in-memory. Move them to a shared store before running more than one instance.
- SQLite is fine for one server. Move to PostgreSQL if you need several.
