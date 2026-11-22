# Database Architecture

## Status and scope

This document is a design proposal for the first Spacimore marketplace
database. It does not create a database, Prisma schema, or migration.

The selected database is Neon Cloud PostgreSQL. The NestJS API in `apps/api`
will access it through Prisma as part of the existing modular monolith.
Next.js and future Flutter clients use the versioned API; database credentials
and data access remain server-side.

The initial schema should favor a small relational core, explicit ownership,
and reliable order and money records. A domain listed as “later” below is
designed for, not a requirement to build in the first release.

## Approved MVP decisions

The product owner has approved the following decisions for the initial
marketplace. They are requirements for schema and service design, not a
completed implementation:

1. Launch geography is Nigeria. Keep country and address fields explicit so
   the model can support additional countries later.
2. Initial currency is NGN. Store NGN monetary amounts as integer kobo in
   PostgreSQL `BIGINT`/Prisma `BigInt`; include a currency code with monetary
   records. Do not assume future currencies use kobo or the same minor-unit
   scale.
3. Paystack is the initial customer payment provider. Paystack is also the
   planned vendor payout provider, subject to its supported payout capabilities.
4. Vendor onboarding supports both individuals and registered businesses.
5. A user can have multiple roles; becoming a vendor does not require a second
   user account.
6. A vendor can own multiple stores.
7. One checkout can include products from multiple stores.
8. A checkout creates one parent order and separate vendor/store suborders for
   fulfillment and operational status tracking.
9. Refunds support order-item-level tracking, including the items and
   quantities covered by a refund.
10. Commission configuration can target a vendor or a category. The effective
    commission terms used are snapshotted on each order item.
11. Inventory is tracked per product and warehouse.
12. Financial records use an append-only double-entry ledger; balances are
    derived from posted entries, not stored as the only source of truth.
13. Vendor settlements require administrative approval in the MVP. Approval,
    rejection, payout processing, and their actors/timestamps must be
    auditable.

Future multi-country support is a design constraint, not an MVP feature:
retain country and currency explicitly, and define jurisdiction-specific
currency, tax, payment, KYC, and retention rules before expanding.

## Domains and rollout

| Domain | MVP scope | Later scope |
|---|---|---|
| Identity and authentication | `User`, credential hash, verified contact state, session/refresh-token records when authentication is implemented | Additional identity providers and recovery history |
| Roles and permissions | `Role`, `UserRole`; one user may have multiple roles, enforced server-side | `Permission` and role-permission assignments if roles prove insufficient |
| Vendor onboarding and verification | `Vendor` with individual or registered-business type, verification status and reviewed KYC metadata | Multiple vendor members, complex review history, automated checks |
| Vendor stores | Multiple `Store`s owned by one vendor | Multiple store staff, store operating schedules |
| Product catalogue | `Product`, store ownership, status, SKU, price, category | Variants, product moderation history, search projections |
| Categories | Hierarchical `Category`; one primary category per MVP product | Product-to-many-category join if validated as needed |
| Product images and attributes | Ordered `ProductImage` object references and `ProductAttribute` values | Rich media processing and variant-defining attributes |
| Inventory and warehouses | `Warehouse`, `Inventory` unique per product and warehouse | Stock movement history, reservations/holds |
| Shopping carts | One active `Cart` per user, `CartItem` | Guest carts and cart history |
| Wishlists | `Wishlist`, `WishlistItem` | Multiple named lists and sharing |
| Customer addresses | `Address` owned by a user; order copies a delivery-address snapshot | Address validation/enrichment history |
| Orders and items | Parent `Order`, per-store/vendor `VendorOrder` suborders, immutable `OrderItem` commercial snapshots | Returns and more complex split-fulfillment policies |
| Payments and refunds | Paystack payment attempts, verified provider references, idempotency, and order-item-level refund allocations | Additional payment providers and more complex refund policy |
| Vendor commissions | Configurable commission policies targeted by vendor or category; snapshot the applied terms per order item | More complex targeting and promotions funded by the platform |
| Vendor settlements | Paystack payout integration subject to capability; settlement request, mandatory admin approval, payout references, and ledger postings | Automated approval/schedules, reserve rules, multi-currency payouts |
| Logistics and shipments | MVP may record a shipment and tracking state if fulfillment requires it | Carrier integrations, parcel/leg modeling, returns |
| Reviews and ratings | Later; purchase-verified review linked to a user and product/order item | Moderation, seller/store reviews |
| Coupons and promotions | Later unless required for launch; coupon, promotion, redemption | Stacking, targeted campaigns, vendor-funded discount allocation |
| Notifications | Later; notification/outbox records only when delivery is implemented | Preferences, channel delivery attempts and templates |
| Audit logs | MVP for security-sensitive changes and all financial state transitions | Broader business-event retention and analytics |
| Platform settings | Later or a small, audited settings table if operations require runtime configuration | Typed settings history and scoped overrides |

Authentication tokens and KYC documents are sensitive. Store token hashes and
document metadata/object-storage keys, not raw refresh tokens or document
contents, in ordinary relational records.

## Core entity relationships

- One `User` may have many `Role`s through `UserRole`. A vendor owner is the
  same user account, associated with a `Vendor`; becoming a vendor does not
  create a second shopper account.
- A `Vendor` owns many `Store`s. Each `Store` has many `Product`s.
- A `Vendor` records whether onboarding is for an individual or registered
  business. Verification requirements may differ by type, but those rules
  remain subject to the KYC decision below.
- Each MVP `Product` has one primary `Category`, many images and attributes,
  and one or more inventory rows associated with store warehouses.
- A user may own many addresses, carts, and wishlists. Cart and wishlist line
  items refer to catalogue products, not a copied product record.
- A customer checkout creates one parent `Order`. Its items are grouped into
  `VendorOrder` suborders by store/vendor so multiple stores can participate
  in the same checkout while fulfillment and operational status remain
  separable. Each `OrderItem` belongs to one suborder and retains product
  name, SKU, vendor/store, unit price, quantity, commission terms, and
  allocated discounts as immutable checkout snapshots.
- Payment attempts apply to the parent order. Refund records reference the
  payment/order and have item allocations that record which order items and
  quantities were refunded.
- Vendor earnings are attributed to order items. Commissions, refunds,
  adjustments, and settlements are recorded in the ledger; settlements are
  not computed from a mutable balance field.

See [Entity Relationships](./ENTITY_RELATIONSHIP.md) for Mermaid diagrams and
[the Data Dictionary](./DATA_DICTIONARY.md) for proposed fields and constraints.

## PostgreSQL and Prisma standards

### Identifiers and references

- Use PostgreSQL UUID primary keys for domain records. Generate IDs in the
  application or with a database UUID default consistently; Prisma models
  should expose UUIDs as strings.
- Use foreign keys for every durable relationship. Prefer `RESTRICT` for
  referenced financial, order, user, vendor, and catalogue records; use
  `CASCADE` only for dependent, non-financial children such as an unsubmitted
  cart item when deleting its cart.
- Use explicit join models where a relationship has its own lifecycle,
  metadata, or audit needs (`UserRole`, `WishlistItem`, `Inventory`).
- Never rely on a client-supplied ID or role as proof of ownership or
  authorization.

### Uniqueness and indexes

At minimum, enforce:

- normalized user email uniqueness; normalized phone uniqueness when present;
- `(user_id, role_id)` uniqueness;
- vendor owner uniqueness for the MVP one-owner model;
- `(store_id, sku)` uniqueness;
- `(product_id, position)` for image ordering and
  `(product_id, normalized_name)` for attribute uniqueness;
- `(warehouse_id, product_id)` uniqueness for inventory;
- one cart and one wishlist per user in the MVP;
- `(cart_id, product_id)` and `(wishlist_id, product_id)` uniqueness;
- unique payment-provider event IDs and provider transaction references in
  their applicable provider scope;
- `(order_id, store_id)` uniqueness for one `VendorOrder` per store in a
  checkout, and `(refund_id, order_item_id)` uniqueness for an item allocation
  within a refund;
- targeted commission-policy lookup by vendor/category, status, and effective
  window; uniqueness/precedence rules require the policy decision below;
- unique ledger source/idempotency keys and unique settlement payout
  references where the provider supplies them;
- unique `SettlementEntry.ledger_entry_id` for the MVP full-entry allocation
  model, so one payable posting cannot be included in multiple settlements.

Index foreign-key columns used for joins and deletion checks. Add query-shaped
indexes for active products by store/category/status, orders by customer and
creation time, vendor order-item/settlement queues by status and time, and
ledger entries by account and posting time. Use partial indexes for “active”
or “unprocessed” rows where PostgreSQL predicates materially improve a
measured query. Avoid speculative indexes on every column.

### Timestamps and deletion

- Store timestamps as PostgreSQL `timestamptz` in UTC. Persist `created_at`
  and `updated_at` on mutable domain rows; update `updated_at` on every
  application-level change.
- Use `deleted_at` only for recoverable user-facing catalogue/profile entities
  where product policy permits it. A soft-deleted record must not be selectable
  for new transactions.
- Do not soft-delete or cascade-delete orders, payments, refunds, ledger
  accounts/entries, settlements, or audit events. Correct them through
  explicit reversal, status transition, or compensating ledger entries.
- User erasure should be a controlled privacy workflow: remove or anonymize
  personal data where legally allowed, retain legally required financial and
  audit evidence with minimized/pseudonymized identity, and preserve
  referential and reconciliation integrity.

### Monetary values and currency

- For the approved initial NGN scope, store every monetary amount as an
  integer number of **kobo** using a PostgreSQL `BIGINT`/Prisma `BigInt`,
  never a floating-point type. API boundaries must serialize large integer
  values safely (typically decimal strings) rather than silently losing
  precision in JavaScript numbers.
- Store an ISO 4217 currency code on orders, payments, ledger accounts,
  entries, refunds, and settlements. The approved initial currency is `NGN`;
  an amount is meaningful only with its currency.
- The approved integer-kobo representation applies to initial NGN records.
  Before adding another currency, define its minor unit and provider
  conversion behavior; do not assume every currency has two decimal places or
  label its minor unit “kobo.” Currency-specific storage units for a future
  country are an implementation decision to resolve before expansion.
- Snapshot unit amounts, discount allocations, commission amounts, shipping,
  tax, and totals at checkout. Define rounding and allocation rules centrally
  before implementation.

## Transactions, inventory, and state

- Use a Prisma/PostgreSQL transaction for checkout operations that must commit
  together: validate prices and stock, reserve/decrement inventory, create the
  parent order, group items into per-store/vendor suborders, create immutable
  items and a Paystack payment attempt, and record any corresponding ledger
  intent/posting. Do not hold a database transaction open while making a
  network call to Paystack.
- Protect inventory using conditional atomic updates (for example, decrement
  only where available quantity is sufficient) or row locks inside a short
  transaction. Check the affected-row count; on conflict, reject or retry
  checkout. A read-then-write without concurrency protection is insufficient.
- If reservation expiry is needed, add explicit reservation rows and expiry
  processing rather than treating a cached quantity as authoritative.
- Define allowed order, payment, refund, shipment, and settlement transitions
  in backend services. Persist status and transition timestamps; do not accept
  arbitrary client status changes. Payment provider webhooks are verified and
  idempotently applied before an order is marked paid.

## Financial ledger

Balances are derived views, not authoritative stored totals. Use a small
double-entry ledger:

- `LedgerAccount` identifies a platform, customer-clearing, vendor-payable,
  processor-clearing, fee, refund, or adjustment account and its currency.
- `LedgerJournal` represents one immutable, balanced business posting and
  references its source (payment, order, refund, commission, settlement, or
  adjustment), idempotency key, effective time, and actor/system origin.
- `LedgerEntry` records signed direction as separate debit/credit integer
  amounts (one side non-zero) against a ledger account. A journal must balance
  per currency: total debits equal total credits.
- Corrections use a new reversing/compensating journal linked to the original;
  posted journals and entries are never edited or deleted.
- Store order- and item-level snapshots alongside the ledger references so
  customer totals and vendor entitlements can be explained without recomputing
  historical catalogue prices or commission policies.

Illustrative posting flow (provider choice is approved; exact account mapping
and fee treatment remain subject to Paystack capability and accounting
implementation):

1. A verified customer payment debits processor clearing and credits customer
   funds held/payable.
2. Commission recognition transfers the approved commission from vendor
   payable to platform commission revenue; vendor payable is based on captured
   item proceeds less commission and explicitly allocated adjustments.
3. A refund debits the appropriate held/vendor/platform accounts and credits
   processor clearing or refund payable, reversing the original economic
   allocation as policy requires.
4. After an administrator approves a settlement request, settlement debits
   vendor payable and credits payout clearing. Submit the payout through
   Paystack only if the required capability is supported and enabled.
   Provider confirmation reconciles the payout clearing entry; a failure is
   recorded as a compensating entry, not by erasing the settlement history.

The finance service must reject unbalanced journals and reuse the same
idempotency key for retries of one logical operation. A unique database
constraint is the final defense against duplicate webhook or payout posting.

## Payment, settlement, and reconciliation lifecycle

1. **Initiate:** Create a parent order, store/vendor suborders, item snapshots,
   and Paystack payment attempt with a server-generated idempotency key;
   request provider checkout without trusting a client “success” flag.
2. **Verify:** Verify webhook signature and provider event/transaction status.
   Record the provider event ID with a unique constraint, validate amount and
   currency against the order, then update payment/order and post the ledger
   journal atomically. Duplicate events return the original result.
3. **Commission:** Resolve the applicable vendor- or category-targeted
   commission configuration according to an approved precedence rule, then
   use the commission terms snapshot stored at checkout.
   Recognize earnings only according to the agreed capture/fulfillment policy.
   Refunds and approved adjustments reduce the vendor entitlement through
   reversals/entries.
4. **Request and approve settlement:** Select eligible vendor payable entries,
   lock or claim them transactionally, create a settlement request and prevent
   the same payable amount from being included twice. An authorized
   administrator must approve or reject it; record the decision and actor
   before submitting an approved payout. The MVP settlement link allocates
   each payable entry in full; partial settlement requires splitting the
   payable into distinct ledger entries or a separately designed allocation
   model. Submit the transfer outside the database transaction.
5. **Confirm or fail:** Persist provider payout results and journal the
   corresponding clearing movement. Failure/cancellation must release or
   compensate the claim exactly once.
6. **Reconcile:** Compare internal payment/payout/refund records and ledger
   totals with provider statements and bank reports. Store statement/import
   references and reconciliation results when this workflow is implemented;
   investigate differences rather than silently adjusting balances.

Do not treat a webhook as a substitute for provider verification, or a
successful API response as proof that a payout ultimately settled.

## Audit, retention, and privacy

- Audit authentication/security events, role changes, vendor verification
  decisions, catalogue moderation, order/payment/refund/commission/settlement
  transitions, platform-setting changes, and privileged actions.
- An audit record includes actor (or system), action, target type/ID, time,
  correlation/request ID, outcome, and a minimized before/after diff where
  useful. Never place passwords, raw tokens, payment credentials, or full
  sensitive documents in audit metadata.
- Keep audit and ledger records append-only to application roles; restrict
  administrative database access and use backups/retention controls.
- Define retention periods by jurisdiction and data class before launch.
  Encrypt transport and provider secrets, restrict access to personal/KYC
  fields, and avoid logging unnecessary personal data.
- Data subject access/deletion must account for order, tax, payment, dispute,
  and audit-retention obligations. Record the approved anonymization and
  retention policy before implementing deletion jobs.

## Remaining implementation decisions

The following details remain open; the approved provider, currency, and
marketplace relationships above should not be reopened as undecided:

1. Confirm which Paystack payment and payout capabilities are enabled for the
   business, the exact webhook signature/event handling, verification calls,
   idempotency key scope, and provider-event retention.
2. Define when vendor earnings become payable (for example, capture,
   fulfillment, or a return-window milestone), the hold/reserve policy, and
   settlement processing/retry procedures. No settlement timeline is assumed.
3. Confirm whether settlements may partially allocate a payable ledger entry.
   The current MVP data model proposes settling each eligible payable entry in
   full; partial settlement needs an explicit allocation model.
4. Define commission calculation mechanics for vendor/category targets:
   precedence when both apply, effective dates, rate/fixed representation,
   rounding, tax/shipping base, discount funding, and adjustments. No
   percentages or tax rates are assumed.
5. Define how parent-order totals, shipping, cancellations, and partial
    refunds are allocated across vendor/store suborders and their items.
6. Define inventory reservation/expiry, oversell handling, and warehouse
    operating rules.
7. Confirm whether one user may own multiple `Vendor` profiles. The current
    relationship proposal has one owner per vendor and a unique vendor owner,
    which would limit each user to one vendor; the approved ability to own
    multiple stores per vendor is unaffected.
8. Define individual versus registered-business verification evidence,
    document storage, reviewer access, and retention.
9. Decide launch requirements for coupons/promotions, reviews, notifications,
    and shipment tracking.
10. Define privacy, financial-record, and audit retention/anonymization periods
    for Nigeria and future jurisdictions.

These are implementation and policy details, not reasons to treat the
approved decisions as undecided or to build speculative tables.
