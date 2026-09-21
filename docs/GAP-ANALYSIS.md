# Gap analysis

What I found in v1, what is now fixed or built, and what is still open. Written to be checked, not admired: each fixed item names the test that would fail if it came back.

## 1. Problems found in v1 (verified by running it)

| # | Problem | Severity | Status | Guarded by |
|---|---|---|---|---|
| 1 | Anyone could register as `admin` or `police` by sending a `role` field | Critical | Fixed. Roles come from memberships; police are created only by an administrator | `security.test.js` "nobody can register themselves as admin or police" |
| 2 | Any user could flag any vehicle stolen and broadcast a nationwide alert | Critical | Fixed. Owners report only their own (unconfirmed until police confirm); police flags need a police membership | "a stranger cannot flag..." |
| 3 | Any user could write any event (including a police clearance) into any passport, and the chain still said "valid" | Critical | Fixed. No generic write endpoint; each event type has a required authority | "no endpoint to write arbitrary blocks" |
| 4 | Passport hash ignored nested fields (an invoice total could change from 9500 to 1 undetected) | High | Fixed. Canonical JSON at every depth | "changing a NESTED value... is detected" |
| 5 | "Signature" was an HMAC with the JWT secret: nobody outside could verify it | High | Fixed. Ed25519, public key published at `/api/public/keys` | "signed with Ed25519 and can be verified with only the public key" |
| 6 | Escrow could be funded with no login; any user could refund or release anyone's | Critical | Fixed. Signed provider webhook only; customer releases, garage refunds, disputes go to an admin | "escrow cannot be funded without a signed callback", "only the customer releases..." |
| 7 | Live GPS of every vehicle, and owner phone numbers, public and broadcast over an open WebSocket | Critical | Fixed. Telemetry is private; sockets must authenticate; nothing is broadcast to the public | "no live GPS, no reporter phone numbers..." |
| 8 | The police console logged itself in with a hardcoded sergeant password | Critical | Fixed. No built-in credentials; non-police accounts are refused | manual + `police.test.js` |
| 9 | Passport validity depended on the working directory (different secrets per launch dir) | High | Fixed. Config resolves from its own location; production refuses default secrets | "production refuses to start with default secrets..." |
| 10 | Police lookups were only logged if the officer chose to log them | High | Fixed. The server records every lookup, with reason and place, in an append-only table | "every lookup is logged by the server" |
| 11 | Citation waiver trusted a client-supplied quiz score (default 100) and mislabelled a waiver as a roadworthiness test | High | Fixed. Server-side answer key; own event type | "citations cannot be waived without passing the course..." |
| 12 | Job cards, telemetry and other routes had no ownership checks | High | Fixed. Every route checks who you are to the record | `orgs.test.js`, `flows.test.js` |
| 13 | The tests never called the API or checked authorization, and shared one mutable database | Medium | Rebuilt: 67 API tests over real HTTP, each file on a throw-away database | `npm test` |
| 14 | `/mobile/` was empty and `/civic/` had no HTML | Medium | Both built | smoke-tested in a browser |

Bugs I introduced while fixing these, caught by the new tests and fixed:
- A rolled-back odometer attempt erased its own evidence (recorded inside the transaction it then aborted). Now recorded first.
- Route guards written as `router.use(auth)` applied to every request reaching the router, which would have locked administrators out. Now scoped by path.
- The public history exposed police case numbers and owners' names through block descriptions. Now generic labels except garage-sealed work.
- A person flag still awaiting a second officer appeared at a roadside stop and recorded a sighting. Pending person flags now never act.

## 2. What you asked for, and where it stands

| Request | Status |
|---|---|
| Fresh development environment | Done. `npm run setup`, one command |
| Service-due animated bar, green to red | Done. The finish-line bar; learns real usage; alerts at 80%, 95%, overdue, seriously overdue |
| Oil type and how long it lasts, mileage to the finish line, due date | Done. Mineral, semi-synthetic, full synthetic, per vehicle type; distance or time, whichever first; severe-service reduction; per-vehicle overrides |
| Cars, motorbikes, trucks, tractors, taxis, minibuses, keke | Done (tractors by engine hours) |
| Car wash | Done. 14-day clock in the same engine |
| Mechanic accounts attached to garages by employment or ownership; boss manages staff | Done. One person, many memberships; rank rules; suspend takes effect at once |
| Assign a driver / lending the car, rentals, family | Done. Time-boxed authorisations, revoke mid-journey, licence-vs-vehicle check on start |
| Driver profile and licence, something the police can look up | Done. Licence with Gambian groups, rotating 60-second live code, verification by the authority |
| Police pull a vehicle without speaking to the driver | Done. Plate check shows declared driver, authority, licence cover, documents, flags |
| Red alerts, persons of interest | Done. With the safeguards in section 4 |
| Custom icons, favicon, tiles, native | Done. 67 icons; favicons (SVG/PNG/ICO); Apple, Android adaptive and maskable icons; Windows tiles; pinned-tab icon; two manifests |
| UI overhaul, fix the generic web UI | Done for website, app and console (see screenshots in the conversation) |
| Match the Gambian licence categories | Done, with the source caveat in section 3 |

## 3. Needs a human decision (I could not settle these from public sources)

1. **Licence groups.** The table (A private car, B motorcycle, C commercial, D special type) comes from a community wiki, not the issuing authority (GAMBIS blocks automated access). Mappings I am sure of are marked `confirmed`; the rest (taxi, minibus, bus, keke, tractor) are `assumed`, and a mismatch shows to police as a *warning to verify*, never a failure. Confirm with the Gambia Police Force Traffic Directorate: `packages/core/src/catalog.js`.
2. **Fine schedule.** Amounts are placeholders: `apps/api/src/routes/citations.js`.
3. **Service intervals.** Typical defaults, not manufacturer data. Have a mechanic you trust review them: `packages/core/src/catalog.js`.
4. **Who verifies licences and documents.** Today an administrator does. The real answer is an integration with the issuing authority, insurers and the revenue authority. That needs their agreement, not code.
5. **Legal basis for police access and person flags.** The system enforces two-person approval, expiry, audit and minimal disclosure. Whether that satisfies Gambian law and the Gambia Police Force's own procedures needs a lawyer and the Force.
6. **Data protection.** Owner and driver data is personal data. Get advice on consent, retention and cross-border hosting before real users.
7. **Mobile money.** Escrow works in sandbox. Live needs contracts with Afrimoney and QMoney and their real webhook formats: `apps/api/src/services/momo.js`.

## 4. Safeguards on the police side (so it can be defended)

Every lookup is written by the server with the officer, badge, reason, place and outcome, and cannot be edited or deleted. Persons of interest expire within 90 days. A person flag or amber alert needs a supervisor who did not create it. Restricted detail is visible only to the creator and supervisors. Tracking works only for vehicles on the active stolen list, is audited, and never applies to people. Unconfirmed owner reports are visible but are not a red alert. An unapproved person flag never appears at a stop.

## 5. Not built yet

From your prototypes: **insurance quotes and claims, vehicle sales listings, ride and vehicle booking, the car-culture feed, mechanic gigs, dispute resolution UI, parts marketplace checkout** (the parts catalogue exists, read-only). The OBD-II parser from v1 is in `legacy/` and is not ported.

Engineering: native iOS/Android builds (the PWA runs on the same API), QR codes for licence and plate (a live text code works today), push notifications (in-app and realtime work), SMS/USSD fallback, Kriol/Mandinka/Wolof translations, real map tiles (the map is a schematic grid), self-hosted fonts, a web dashboard for garage bosses (staff management lives in the app), an administrator UI (the API exists; the admin queue is API-only), rate limiting on a shared store for more than one server, PostgreSQL if you outgrow SQLite.

## 6. Ideas worth doing next

Garage custody: opening a job automatically gives the garage's mechanic a "garage" authorisation so a test drive is legitimate. A "sold" handshake with the buyer's phone confirming the odometer. Fleet dashboards for taxi and minibus owners. Fuel and cost tracking. Recall notices. Crash and SOS from the phone. Owner-side "who checked my vehicle" history. Harmattan-season shorter wash and air-filter intervals.
