# TicketHub: Event Ticketing System

TicketHub sells reserved seats for concerts and events. This complete document
uses six parts: requirements, estimates, API, data model, architecture and
trade-offs. **A database transaction decides who owns a seat; a cached seat map
or a successful browser redirect never proves that a ticket was bought.**

**Review update:** the implementation detail requested in feedback is below:
[full schema and foreign keys](#41-executable-postgresql-schema),
[exact locking transaction and two-session test](#42-exact-hold-transaction), and
[architecture diagram](#51-architecture-diagram). All six design parts remain
in this single file; the reflection is the separate reflection.md file.

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

Use PostgreSQL transactions and constraints for authoritative inventory. IDs are
allocated by the backend, timestamps are UTC, and prices are integer minor units.
Users have many orders; events have many seats and orders; one seat has many
historical orders but at most one active claim. Each order has at most one
payment and one ticket. Users and events are many-to-many through orders.

### 4.1 Executable PostgreSQL schema

Run these CREATE statements once in a fresh PostgreSQL database, in this order.
The six domain tables include explicit primary keys, foreign keys, state checks
and uniqueness. The two operational tables support durable callbacks/outbox
publication. A separately managed waiting-room ledger enforces one queue entry
per user/event. These statements are PostgreSQL SQL, not SQLite SQL.

```sql
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  auth_subject TEXT NOT NULL UNIQUE
);
CREATE TABLE events (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL, venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  sale_opens_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED','OPEN','SOLD_OUT','CANCELLED')),
  CHECK (starts_at > sale_opens_at)
);
CREATE TABLE seats (
  id BIGINT PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id),
  section TEXT NOT NULL, seat_number TEXT NOT NULL,
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency CHAR(3) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('AVAILABLE','HELD','PAYMENT_PENDING','SOLD')),
  current_order_id TEXT,
  hold_expires_at TIMESTAMPTZ,
  UNIQUE (event_id, section, seat_number),
  UNIQUE (id, event_id),
  CHECK (
    (state = 'AVAILABLE' AND current_order_id IS NULL AND hold_expires_at IS NULL) OR
    (state = 'HELD' AND current_order_id IS NOT NULL AND hold_expires_at IS NOT NULL) OR
    (state IN ('PAYMENT_PENDING','SOLD') AND current_order_id IS NOT NULL AND hold_expires_at IS NULL)
  )
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  event_id BIGINT NOT NULL REFERENCES events(id),
  seat_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('HELD','PAYMENT_PENDING','PAID','EXPIRED','CANCELLED','FAILED','REFUND_REQUIRED')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  hold_expires_at TIMESTAMPTZ NOT NULL,
  initial_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (seat_id, event_id) REFERENCES seats(id, event_id),
  UNIQUE (user_id, request_key),
  UNIQUE (id, seat_id, user_id),
  UNIQUE (id, seat_id, event_id)
);
-- Added after orders exists; this also checks that the order owns THIS seat/event.
ALTER TABLE seats ADD CONSTRAINT seats_current_order_fk
  FOREIGN KEY (current_order_id, id, event_id)
  REFERENCES orders(id, seat_id, event_id);
CREATE UNIQUE INDEX one_live_order_per_seat ON orders(seat_id)
  WHERE status IN ('HELD','PAYMENT_PENDING','PAID');
CREATE UNIQUE INDEX one_live_order_per_user_event ON orders(user_id, event_id)
  WHERE status IN ('HELD','PAYMENT_PENDING','PAID');
CREATE INDEX orders_user_history ON orders(user_id, created_at DESC);
CREATE INDEX seats_event_expiry ON seats(event_id, state, hold_expires_at);
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider_reference TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN
    ('NEW','PENDING','SUCCEEDED','CANCELLED','FAILED','REFUND_PENDING','REFUNDED')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  seat_id BIGINT NOT NULL UNIQUE REFERENCES seats(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  qr_token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (order_id, seat_id, user_id) REFERENCES orders(id, seat_id, user_id)
);
CREATE TABLE webhook_events (
  provider_event_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ
);
```

The event/seat composite FK prevents an order naming a seat from another event.
The reverse FK ensures a seat's current order names that same seat/event; adding
it after orders exists resolves the circular table-creation dependency. The
composite ticket FK checks the ticket's buyer and seat against its order. Default
NO ACTION deletion behavior retains financial history rather than cascading it
away. Prices and the original hold response are immutable through the API.

The two partial unique indexes enforce one live order per seat and per
account/event. FAILED, EXPIRED and CANCELLED attempts remain as history but do
not reserve inventory. Held deadlines remain on orders for idempotent replay;
PAYMENT_PENDING clears the seat deadline and cannot be freed just by a timer.
Index history/expiry reads as shown, but measure index cost. PostgreSQL describes
[constraint enforcement](https://www.postgresql.org/docs/current/ddl-constraints.html).

### 4.2 Exact hold transaction

This is executable PL/pgSQL, not a placeholder locking instruction. Install it
once after the schema. Only a trusted backend role may execute it: the API must
validate authentication, admission and rate limits, derive `p_user_id` from the
login, generate `p_order_id`, and hash the canonical request on the server.
Clients never receive database credentials. Grant the backend role EXECUTE
explicitly in deployment; the function is SECURITY INVOKER, not a privilege bypass.

```sql
CREATE OR REPLACE FUNCTION tickethub_hold_seat(
  p_user_id BIGINT, p_event_id BIGINT, p_seat_id BIGINT,
  p_order_id TEXT, p_request_key TEXT, p_request_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_seat seats%ROWTYPE;
  v_existing orders%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_expires TIMESTAMPTZ;
  v_response JSONB;
BEGIN
  -- The API supplies authenticated user ID, generated order ID and canonical hash.
  IF p_request_key IS NULL OR btrim(p_request_key) = '' OR
     p_request_hash IS NULL OR btrim(p_request_hash) = '' THEN
    RAISE EXCEPTION 'INVALID_REQUEST_KEY' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_existing FROM orders
    WHERE user_id = p_user_id AND request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash OR
       v_existing.seat_id <> p_seat_id OR v_existing.event_id <> p_event_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing.initial_response;
  END IF;

  -- The crucial lock: another transaction cannot claim this row until we finish.
  SELECT * INTO v_seat FROM seats
    WHERE id = p_seat_id AND event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SEAT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- A same-key concurrent call might have completed while this call waited.
  SELECT * INTO v_existing FROM orders
    WHERE user_id = p_user_id AND request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash OR
       v_existing.seat_id <> p_seat_id OR v_existing.event_id <> p_event_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing.initial_response;
  END IF;

  v_now := clock_timestamp(); -- Fresh after waiting for the seat lock.
  PERFORM 1 FROM events WHERE id = p_event_id AND status = 'OPEN'
    AND sale_opens_at <= v_now AND starts_at > v_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_NOT_OPEN' USING ERRCODE = 'P0001';
  END IF;
  IF v_seat.state = 'HELD' AND v_seat.hold_expires_at <= v_now THEN
    UPDATE orders SET status = 'EXPIRED'
      WHERE id = v_seat.current_order_id AND status = 'HELD';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CLAIM_STATE_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    UPDATE seats SET state = 'AVAILABLE', current_order_id = NULL,
      hold_expires_at = NULL WHERE id = p_seat_id;
    v_seat.state := 'AVAILABLE';
  END IF;
  IF v_seat.state <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'SEAT_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  v_expires := v_now + INTERVAL '5 minutes';
  v_response := jsonb_build_object('orderId', p_order_id, 'seatId', p_seat_id,
    'status', 'HELD', 'expiresAt', v_expires,
    'amountMinor', v_seat.price_minor, 'currency', btrim(v_seat.currency));
  INSERT INTO orders(id, user_id, event_id, seat_id, status, amount_minor,
      currency, request_key, request_hash, hold_expires_at, initial_response)
    VALUES(p_order_id, p_user_id, p_event_id, p_seat_id, 'HELD', v_seat.price_minor,
      v_seat.currency, p_request_key, p_request_hash, v_expires, v_response);
  UPDATE seats SET state = 'HELD', current_order_id = p_order_id,
    hold_expires_at = v_expires WHERE id = p_seat_id;
  RETURN v_response;
EXCEPTION WHEN unique_violation THEN
  -- PostgreSQL rolls back this function block's changes before this handler.
  SELECT * INTO v_existing FROM orders
    WHERE user_id = p_user_id AND request_key = p_request_key;
  IF FOUND AND v_existing.request_hash = p_request_hash AND
      v_existing.seat_id = p_seat_id AND v_existing.event_id = p_event_id THEN
    RETURN v_existing.initial_response;
  END IF;
  RAISE; -- Purchase-limit or other uniqueness conflict: API returns 409.
END;
$$;
REVOKE ALL ON FUNCTION tickethub_hold_seat(BIGINT,BIGINT,BIGINT,TEXT,TEXT,TEXT)
  FROM PUBLIC;
```

In a fresh test database, run this fixture after the schema and function:

```sql
INSERT INTO users(id, name, email, auth_subject) VALUES
  (1, 'Judith Kerubo', 'judith.kerubo@example.com', 'demo-judith'),
  (2, 'Peter Onyango', 'peter.onyango@example.com', 'demo-peter');
INSERT INTO events(id, title, venue, starts_at, sale_opens_at, status) VALUES
  (7, 'Demo concert', 'Demo venue', clock_timestamp() + INTERVAL '2 days',
   clock_timestamp() - INTERVAL '1 day', 'OPEN');
INSERT INTO seats(id, event_id, section, seat_number, price_minor, currency, state)
  VALUES (42, 7, 'A', '42', 300000, 'KES', 'AVAILABLE');
```


The application calls it on **one primary-database connection**, with bound
parameters, and sends 201 only after COMMIT succeeds. For a worked example,
assume users 1 (Judith Kerubo) and 2 (Peter Onyango), open event 7 and available
seat 42 already exist. The example hash is illustrative; the API computes a
real canonical-request hash in production.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '2s';
SELECT tickethub_hold_seat(
  1, 7, 42, 'order-judith-001', 'request-judith-001', 'demo-hash-event7-seat42'
);
-- In a two-session test, pause here before committing.
COMMIT;
```

While session A is paused, run this in a **separate PostgreSQL connection**:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '2s';
SELECT tickethub_hold_seat(
  2, 7, 42, 'order-peter-001', 'request-peter-001', 'demo-hash-event7-seat42'
);
-- It waits for A; after A commits it raises SEAT_UNAVAILABLE.
-- If A stays open longer than two seconds, this attempt hits the lock timeout.
ROLLBACK;
```

The API must ROLLBACK on any error before reusing the connection. Map
`SEAT_UNAVAILABLE`, `IDEMPOTENCY_KEY_REUSED` and purchase-limit unique violations
to 409; map `SEAT_NOT_FOUND` to 404. A lock timeout is a bounded retry/503 case,
not proof that the other buyer failed. Reuse the same request key on retries.
The function's unique-violation handler rolls back its tentative changes and
returns an existing result only when that user's key, event, seat and hash match.

### Why two buyers cannot both win

Judith locks seat 42 first. Peter must wait or time out; he cannot update a
second copy of that row. After Judith commits, Peter reads her HELD claim and
is rejected. If Judith rolls back, Peter can claim it. Order creation and the
seat update succeed together or roll back together, including expired-claim
replacement. PAYMENT_PENDING and SOLD are never reclaimed by this function.

The partial unique index independently prevents two live orders for one seat;
`tickets.seat_id UNIQUE` prevents two issued tickets. All expiry/payment paths
must lock the same seat first and then its order. Do not use an unlocked
check-then-insert, Redis or a read replica as the booking authority. See
[PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html)
and [PL/pgSQL result/error handling](https://www.postgresql.org/docs/current/plpgsql-statements.html).


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

### 5.1 Architecture diagram

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
The revised schema and hold function were executed from these Markdown SQL
blocks in embedded PostgreSQL (PGlite). Checks passed for foreign keys,
idempotent replay, purchase limits, expiry replacement, rollback, pending-payment
protection, sold-seat rejection and ticket uniqueness. That engine exposes one
session, so the separate-connection blocking exercise above still needs a
PostgreSQL server; it is not claimed as a completed concurrency/load test.
Also load-test the admission cap and burst, simulate queue/cache/zone failures,
and restore a backup. These are required validation steps, not claimed production
load-test results. The design is complete through this final section.
