# TicketHub: Event Ticketing System

TicketHub sells reserved seats for concerts and events. This complete document
uses six parts: requirements, estimates, API, data model, architecture and
trade-offs. **A database transaction decides who owns a seat; a cached seat map
or a successful browser redirect never proves that a ticket was bought.**

## 1. Requirements

### Functional

- Browse/search events, inspect event details and view a paginated seat map.
- Sign in, temporarily hold an available seat, pay and view the issued ticket.
- Cancel an unpaid hold or release it after expiry; show processing, conflict,
  expiry, failure and sold-out states clearly.
- Keep a recoverable order/payment history and deliver a receipt asynchronously.
- For a popular sale, join a waiting room and receive a fair admission position.

Scope: **one seat per order and at most one active/paid order per account per
event**. Group bookings, resale, seat transfers and releasing refunded seats
for resale are outside this first version. A seat belongs to one event, not
just to a reusable venue layout. Only card payments with a promptly reconcilable
payment outcome are included; delayed bank transfers are excluded.

### Non-functional

- **Correctness:** never confirm two buyers for the same event seat; never
  issue a ticket from an unverified payment or charge twice on an ordinary retry.
- **Speed:** proposed p95 targets are under 500 ms for event reads and under
  1 second for a hold after admission, excluding queue wait and payment-provider
  time. These require measurement, not an assumed server count.
- **Fairness:** publish the queue rules; allow one queue entry per account/event;
  enforce purchase limits, rate limits and bot controls with accessible fallbacks.
  Multiple accounts remain an abuse risk, so do not promise perfect bot prevention.
- **Availability:** target 99.9% monthly availability; use multiple zones and
  tested failover. Prefer temporarily refusing bookings to overselling seats.
- **Security/durability:** HTTPS, ownership checks, prepared SQL, server-side
  prices, encrypted storage, verified payment callbacks and tested backups;
  hosted payment fields keep card numbers and security codes out of TicketHub.

## 2. Estimates: normal day versus a popular sale

Given: 2 million registered users, 50,000 normal daily visitors, 10 pages per
visitor, 5,000 daily ticket sales, and 200,000 prospective buyers competing for
20,000 seats in 10 minutes. Use 86,400 seconds/day and 600 seconds/10 minutes.

| Quantity | Calculation | Result |
| --- | --- | ---: |
| Normal page views/day | 50,000 x 10 | 500,000 |
| Normal page views/second | 500,000 / 86,400 | 5.79 |
| Normal completed sales/second | 5,000 / 86,400 | 0.0579 |
| Sale-window buying attempts/second | 200,000 / 600 | 333.33 |
| Completion rate needed to sell out in 10 minutes | 20,000 / 600 | 33.33 tickets/second |
| Demand compared with available seats | 200,000 / 20,000 | 10 buyers/seat |
| Completion target versus normal sales rate | (20,000 / 600) / (5,000 / 86,400) | 576x |

Only 10% of those buyers can receive a seat under the one-ticket rule. The
333.33 attempts/second figure is an **average within the sale window**, not a
guaranteed peak, and attempts are not completed sales or SQL operations.

Additional sizing assumptions: five dynamic browsing/seat-map reads per sale
visitor give 1,000,000 reads/600 = **1,666.67 read requests/second** before
caching. One hold attempt per visitor gives 333.33 hold requests/second before
admission control; retries increase this. Each successful purchase also needs
payment initiation, a callback and several database writes.

For a stress scenario, assume all 200,000 visitors arrive in the first minute:
**3,333.33 arrivals/second**, ten times the ten-minute arrival average. If every
queued visitor polls every 30 seconds, that adds up to **6,666.67 queue-status
requests/second**; use jitter and serve these at the waiting-room tier. Static
asset requests, authentication, payment retries and callbacks need extra headroom.
Do not send waiting-room polls to the booking database.

Load-test the edge against the burst, then cap admission using measured database
and payment capacity. An initial *test hypothesis* is 100 new admissions/second,
with a separate limit on concurrent checkouts. It is not a proven throughput
guarantee. Model checkout duration and abandonment before selecting that limit;
holding seats does not guarantee all 20,000 will be paid for in ten minutes.

## 3. API

Base path: `/api/v1`; HTTPS and JSON. Protected endpoints derive the user from
a validated bearer token. User-facing requests can access only owned holds,
orders and tickets. Require a valid waiting-room admission for **new holds**
during the popular sale; an already valid hold can finish payment even if its
admission token later expires.

| Method and path | Purpose | Success |
| --- | --- | --- |
| `GET /events?cursor=...` | Browse/search paginated events. | 200 |
| `GET /events/{eventId}` | Read event details and sale opening time. | 200 |
| `GET /events/{eventId}/seats?section=A` | Read a paginated, timestamped availability snapshot. | 200 |
| `POST /events/{eventId}/queue-entries` | Join the waiting room once per account/event. | 201; repeat returns existing entry with 200 |
| `GET /queue-entries/{id}` | Read owned waiting/admitted/sold-out status. | 200 |
| `POST /holds` | Atomically reserve one seat and create its order. | 201 |
| `GET /holds/{orderId}` | Read owned hold state and server expiry time. | 200 |
| `DELETE /holds/{orderId}` | Cancel an owned HELD order and release its seat. | 204 |
| `POST /orders/{id}/payment` | Start/retrieve one hosted checkout for an owned valid hold. | 201; 202 while outcome/setup is pending |
| `GET /orders/{id}` | Read current authoritative order/payment state. | 200 |
| `GET /me/tickets` | List the caller's confirmed tickets. | 200 |
| `POST /webhooks/payment` | Verify and durably record a provider event for processing. | 200 after durable acceptance |

Example `POST /holds`, with `Idempotency-Key: <random-request-key>`:

```json
{ "eventId": 7, "seatId": 42 }
```

Example 201 response for sample buyer Judith Kerubo; the price comes from SQL:

```json
{
  "orderId": "order-example-001",
  "seatId": 42,
  "status": "HELD",
  "expiresAt": "2026-10-28T12:05:00Z",
  "amountMinor": 300000,
  "currency": "KES"
}
```

An idempotency key identifies one logical request: same user/key/body returns
the original result; reusing it for a different seat returns 409. Payment setup
uses a stable provider key derived from the order ID, not a new key on retry.
The webhook uses a verified provider signature instead of a user's bearer token.

Errors: **400** invalid fields; **401** missing/invalid login; **403** no valid
admission or purchase permission; **404** missing/not-owned resource; **409**
seat conflict, purchase limit or invalid state transition; **410** expired hold;
**429** rate limit with `Retry-After`; **503** temporary inability to book safely.
An empty ticket list is 200 with `tickets: []`; 204 has no response body.

```json
{ "error": { "code": "SEAT_UNAVAILABLE", "message": "Choose another seat.", "requestId": "req-example-001" } }
```

## 4. Data model and prevention of double-booking

Use a relational database such as PostgreSQL for transactions, ownership and
uniqueness. IDs are generated; timestamps are UTC; money is an integer number
of currency minor units, never a floating-point value.

| Table | Main columns and rules |
| --- | --- |
| users | `id BIGINT PK`, `name TEXT NOT NULL`, `email TEXT UNIQUE NOT NULL`, `auth_subject TEXT UNIQUE NOT NULL`. |
| events | `id BIGINT PK`, `title TEXT`, `venue TEXT`, `starts_at TIMESTAMPTZ`, `sale_opens_at TIMESTAMPTZ`, `status TEXT`; required event fields are NOT NULL. |
| seats | `id BIGINT PK`, `event_id FK events`, `section TEXT`, `seat_number TEXT`, `price_minor BIGINT CHECK >= 0`, `currency CHAR(3)`, `state TEXT`, nullable `current_order_id FK orders`, nullable `hold_expires_at TIMESTAMPTZ`; `UNIQUE(event_id, section, seat_number)` and `UNIQUE(id, event_id)`. |
| orders | `id TEXT PK` (opaque generated ID), `user_id FK users`, `event_id FK events`, `seat_id BIGINT`, `status TEXT`, immutable `amount_minor BIGINT` and `currency CHAR(3)`, `request_key TEXT`, `request_hash TEXT`, `hold_expires_at TIMESTAMPTZ`, `initial_response JSONB`, `created_at TIMESTAMPTZ`; `UNIQUE(user_id, request_key)` and composite FK `(seat_id, event_id) -> seats(id, event_id)`. |
| payments | `id TEXT PK`, `order_id UNIQUE FK orders`, nullable unique `provider_reference TEXT`, `status TEXT`, `amount_minor BIGINT`, `currency CHAR(3)`, `updated_at TIMESTAMPTZ`; one logical payment per order. |
| tickets | `id TEXT PK`, `order_id UNIQUE FK orders`, `seat_id UNIQUE FK seats`, `user_id FK users`, `qr_token_hash TEXT UNIQUE`, `issued_at TIMESTAMPTZ`; seat/user must match the paid order. |

All identifiers and core fields are NOT NULL except the nullable fields named
above. Add the seat-to-order FK after creating orders because it is a circular
reference. A composite FK from tickets `(order_id, seat_id, user_id)` to a unique
orders `(id, seat_id, user_id)` key enforces the ticket/order match. Use CHECK
constraints for permitted states and non-negative amounts. AVAILABLE seats have
no current order/deadline; HELD seats require both; PAYMENT_PENDING and SOLD
seats require their current order. Store the original hold response and deadline
on the order so an idempotent replay does not renew an expired reservation.

Relationships: users have many orders; events have many seats and orders; one
seat has many **historical** orders but at most one live claim; one order has at
most one payment and one ticket. Users and events are many-to-many through
orders. A ticket remains associated with its sold seat; refunds do not return
inventory for resale in this version.

Operational tables: `webhook_events(provider_event_id PK, payload, processed_at)`
deduplicates callbacks; `outbox(id PK, type, order_id FK orders, published_at)`
records work in the same transaction as a business change. A separate durable
waiting-room ledger has `UNIQUE(event_id, user_id)` and an admission position.

Two production constraints provide a second defence beyond application code:

```sql
CREATE UNIQUE INDEX one_live_order_per_seat
ON orders(seat_id)
WHERE status IN ('HELD', 'PAYMENT_PENDING', 'PAID');

CREATE UNIQUE INDEX one_live_order_per_user_event
ON orders(user_id, event_id)
WHERE status IN ('HELD', 'PAYMENT_PENDING', 'PAID');
```

Also index `orders(user_id, created_at DESC)` for history and
`seats(event_id, state, hold_expires_at)` for availability/expiry work. Indexes
cost storage and write work; measure before adding more. PostgreSQL documents
[uniqueness and foreign-key enforcement](https://www.postgresql.org/docs/current/ddl-constraints.html).

### Hold transaction: Judith and Peter cannot both win seat 42

1. Validate login, admission, sale opening time and request fields. Check the
   user's idempotency key; retries return the same order, not another hold.
2. Begin a short SQL transaction and lock the seat using `SELECT ... FOR UPDATE`
   **on the primary**. All inventory paths lock the seat first, then its order,
   so acquisition, expiry, cancellation and payment completion use one ordering.
3. Read a fresh database clock **after acquiring the lock** and recheck that
   the sale is open. If the seat is AVAILABLE, continue. If HELD and expired,
   mark its previous order EXPIRED and clear that claim in this transaction.
   Never reclaim PAYMENT_PENDING merely because the original deadline passed.
4. Create the HELD order, claim the seat and set a five-minute expiry atomically.
   Commit both changes, or roll everything back if any constraint/check fails.
   A concurrent duplicate request-key conflict must roll back and read the
   existing matching result; a changed request body returns 409.
5. If Judith commits first, Peter sees her claim after his lock wait and gets
   409. If Judith rolls back, Peter can proceed. Even faulty code cannot insert
   two live orders for the seat or two tickets with the same seat ID. Retry
   deadlock/lock-timeout errors only within a bounded policy using the same key.

Do not perform an unlocked "check available, then insert" sequence. Do not use
Redis locks, app memory or a lagging read replica as the booking authority.
The mechanism relies on database transaction/locking behavior described in
[PostgreSQL's concurrency documentation](https://www.postgresql.org/docs/current/transaction-iso.html).

### Payment, expiry and retry lifecycle

```text
HELD -> PAID is forbidden directly from a browser request.
HELD -> PAYMENT_PENDING -> PAID -> ticket issued
HELD -> EXPIRED or CANCELLED -> seat AVAILABLE
PAYMENT_PENDING -> confirmed terminal non-payment -> FAILED -> seat AVAILABLE
PAYMENT_PENDING -> unknown outcome -> retain claim and reconcile
```

- The expiry worker locks the seat and rechecks its current order, HELD state
  and database deadline before releasing it; an old delayed expiry job cannot
  release a newer buyer's claim.
- Before contacting the provider, a transaction verifies the still-valid hold,
  records its one payment and moves the claim/order to PAYMENT_PENDING. Commit,
  then call hosted checkout **outside** the transaction; never keep a seat-row
  lock open while a person enters payment details.
- After a network timeout, retry provider setup with the **same order key** and
  reconcile the existing payment. Unknown does not mean failed. After a proposed
  two-minute payment window, request provider cancellation and release only
  after authoritative confirmation that it cannot still charge; provider outages
  can therefore extend a claim and must trigger an alert. Respect the provider's
  idempotency-key retention window: after it expires, do not recreate an unknown
  payment; reconcile its reference/status or escalate for manual resolution.
- Verify callback signatures and persist unique event IDs before acknowledging.
  A payment worker checks the provider reference, amount, currency and current
  authoritative payment status; delayed/out-of-order events must not reverse PAID.
- In one transaction, lock seat/order, verify this order still owns the claim,
  mark PAID/SOLD, insert the unique ticket and a receipt outbox event. Duplicate
  processing returns the existing result. Reconciliation repairs a crash after
  payment success but before local completion.
- If money nevertheless arrives for a released/non-owning order, **never take
  the seat from its new owner**: record REFUND_REQUIRED, retry an idempotent refund
  and alert until resolved. Do not promise exactly-once network delivery.

The provider and SQL database are separate systems, so these recoverable state
transitions replace an impossible single local transaction spanning both.
[Provider idempotency guidance](https://docs.stripe.com/api/idempotent_requests)
supports retry safety; [webhook guidance](https://docs.stripe.com/webhooks)
supports signature checks and duplicate-event handling.

## 5. Architecture and survival of the big sale

| Component | Problem it solves |
| --- | --- |
| Client | Shows queue progress, tentative seats, server hold expiry and confirmed tickets. |
| Managed DNS | Resolves web/API names through redundant authoritative infrastructure. |
| CDN | Serves public pages, images and static files close to visitors. |
| WAF/rate limiter | Filters abusive bursts before they consume booking capacity. |
| Durable waiting room | Orders demand and admits only a measured safe amount of checkout traffic. |
| Redundant load balancer | Routes admitted requests to healthy app instances. |
| Stateless app servers | Share work across zones without tying an order to one server's memory. |
| Redis cache | Reduces repeated event/seat-map reads; cached availability is explicitly tentative. |
| SQL primary and HA standby | Commit authoritative claims and provide a fenced failover target. |
| Read replica | Serves suitable browsing/history reads without deciding holds or payment completion. |
| Durable queue and workers | Deliver receipts, reconcile payments and schedule expiry without blocking checkout requests. |
| Payment provider | Securely collects card payment and reports its independently verified outcome. |

```text
Client --DNS lookup--> Managed DNS
  |
  +-- public assets --> CDN --> replicated static origin
  |
  +-- API --> WAF / rate limits --> Durable waiting room
                                       |
                                 signed admission
                                       v
                              Redundant load balancer
                               /                  \
                       App A (zone A)       App B (zone B)
                               \                  /
                                +--------+-------+
                                |        |       |
                              Redis      |    Read replica
                                         |         ^
                                         v         | async replication
                                    SQL primary ---+
                                         |
                              synchronous HA standby (zone B)

App / outbox publisher --> Durable queue --> Expiry / payment / receipt workers
App / payment workers <--> Hosted payment provider
Provider --signed callback--> dedicated webhook path --> durable inbox / outbox
```

DNS resolves names, not the contents of each request. Webhooks and owned
checkout/status requests bypass the **new-buyer** queue but retain authentication,
ownership/signature checks and separate capacity limits. Private tickets, orders,
payment sessions and hold responses must not be publicly cached at the CDN.

**Fair admission:** randomize accounts already in the published pre-sale waiting
window at opening, then append later arrivals in server-recorded FIFO order.
Refreshing or opening more tabs preserves the account's position. Bind short-lived
admission tokens to account/event; enforce eligibility at the backend, not only
in browser JavaScript. Admission is permission to try, not a seat guarantee.
Stop new admissions once all seats are SOLD, keeping payment completion
available. If seats are only temporarily held or payment-pending, pause new
admissions and show waiting status because some claims may still be released.

**Failure handling:** run apps/workers in multiple zones; use a replicated queue,
durable admission ledger and managed cache failover. If the waiting room fails,
pause new admission rather than bypassing fairness. If Redis fails, rate-limit
database fallbacks. If the primary fails, use managed promotion with fencing
(the old primary cannot continue accepting writes); pause bookings during an
uncertain failover. A read replica is not a backup or an automatically safe
write primary. Maintain encrypted backups, restore drills and monitoring.

Outbox publication retries survive queue outages. Workers acknowledge only
durably completed work, handle duplicate deliveries, and send repeatedly failing
jobs to a dead-letter destination with an alert. Cache invalidation follows seat
changes, but stale displays can only cause a rejected attempt, never another sale.
Monitor queue wait/age, admitted traffic, hold conflicts, payment uncertainty,
replication lag and callback failures. Test the complete purchase path against
the burst; adding app servers alone does not remove a hot-seat/database limit.

## 6. Trade-offs and verification

1. **Correctness versus immediate availability:** uncertain payment or database
   failover temporarily blocks a seat; this loses some short-term sales but
   prevents allocating the same seat twice. Reconciliation and alerts restore progress.
2. **Fair queue versus instant access:** admission protects the database and
   reduces refresh races, but adds visible waiting and operational complexity;
   show honest progress, publish rules and keep existing checkout flows available.
3. **Caching versus freshness:** cached maps and replicas accelerate browsing
   but can be stale; return timestamps and always decide a hold on the primary.
4. **Short holds versus enough checkout time:** a five-minute hold reduces
   abandoned inventory but can frustrate slow buyers; show a server-based
   countdown, separate payment reconciliation and never auto-extend indefinitely.

Acceptance checks: race many buyers for one seat (one winner); retry one request
key (one order); fail one transaction (no partial claim); expire an old hold after
replacement (new owner unaffected); race expiry with payment start (one legal
state wins); deliver duplicate/out-of-order callbacks (one ticket); time out the
provider (retain uncertainty); retry a late payment (refund, no seat theft).
Also load-test the admission cap and burst, simulate queue/cache/zone failures,
and restore a backup. These are required validation steps, not claimed production
load-test results. The design is complete through this final section.
