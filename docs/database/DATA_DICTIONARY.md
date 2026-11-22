# Data Dictionary

Proposed logical fields for database design. Exact Prisma names, enum spelling,
provider fields, and optional columns may change during implementation. `UUID`
is the primary identifier unless noted. Initial launch is Nigeria/NGN:
`BIGINT kobo` means integer NGN minor units; amounts are never floating point.
Future countries must use explicit country/currency and currency-specific minor
unit rules rather than assuming kobo.

Owner-approved decisions are marked **Approved** in the rollout notes and
summarized in [Database Architecture](./DATABASE_ARCHITECTURE.md). Remaining
implementation details are not product approvals.

## Common conventions

- Domain tables use `id UUID`, `created_at TIMESTAMPTZ`, and, for mutable
  records, `updated_at TIMESTAMPTZ`.
- Use `deleted_at TIMESTAMPTZ NULL` only on recoverable catalogue/profile
  records where permitted. Financial, order, and audit data are not deleted.
- Foreign keys are explicit and indexed as required by PostgreSQL query and
  referential actions.
- Status values are constrained enums or validated strings with transitions
  enforced in the backend. Do not accept arbitrary client-written statuses.
- Currency-bearing rows contain `currency CHAR(3)`/ISO 4217 code. Initial
  currency is NGN with integer kobo amounts. Keep country and currency
  explicit for future multi-country support; define that currency's minor
  unit before using the monetary model outside NGN.
- Secrets are stored as strong hashes or in a secret manager, never as plain
  text in database records or environment examples.

## Identity, access, and vendors

| Entity | Core fields | Constraints and notes | Rollout |
|---|---|---|---|
| `User` | `id`, normalized `email`, optional normalized `phone`, `password_hash`, `status`, `email_verified_at`, `phone_verified_at`, timestamps, optional `deleted_at` | Unique normalized email; unique non-null normalized phone; hash passwords with Argon2id; avoid retaining raw credentials | MVP |
| `AuthSession` | `id`, `user_id`, `refresh_token_hash`, `expires_at`, `revoked_at`, `created_at`, optional device metadata | FK to User; index user and expiry; rotate/revoke hashes, never raw refresh tokens | MVP when auth is implemented |
| `Role` | `id`, stable `code`, `name`, `created_at` | Unique code; initial codes may include shopper, vendor, admin, support | MVP |
| `UserRole` | `user_id`, `role_id`, `assigned_at`, optional `assigned_by_user_id` | **Approved:** many-to-many role assignment lets one user hold multiple roles. Composite unique/PK `(user_id, role_id)`; authorization always server-side | MVP |
| `Vendor` | `id`, `owner_user_id`, `onboarding_type` (`INDIVIDUAL` or `REGISTERED_BUSINESS`), `status`, `display_name`, `legal_name`, `country_code`, timestamps | **Approved:** support individual and registered-business onboarding. One owner per vendor for MVP; unique owner ID; owner is an existing User, not a second account | MVP |
| `VendorVerification` | `id`, `vendor_id`, `status`, `submitted_at`, `reviewed_at`, `reviewer_user_id`, `document_object_key`, limited `metadata` | FK to Vendor and reviewer; document contents kept in protected object storage; restrict access and retention | MVP if verification is launch-required |
| `Store` | `id`, `vendor_id`, `name`, normalized `slug`, `country_code`, `status`, `description`, timestamps, optional `deleted_at` | **Approved:** a vendor may own multiple stores. Unique slug; FK to Vendor; country retained for future expansion; prevent new orders while inactive/deleted | MVP |
| `Permission` | `id`, stable `code`, `description` | Unique code; add only when role-level authorization is insufficient | Later |
| `RolePermission` | `role_id`, `permission_id` | Composite PK; explicit fine-grained authorization | Later |
| `VendorMember` | `id`, `vendor_id`, `user_id`, `status`, `invited_by`, timestamps | Unique `(vendor_id, user_id)`; allows staff separate from vendor owner | Later |

## Product catalogue and inventory

| Entity | Core fields | Constraints and notes | Rollout |
|---|---|---|---|
| `Category` | `id`, optional `parent_id`, `name`, normalized `slug`, `status`, `position`, timestamps | Unique slug; index parent/status; prevent invalid hierarchy cycles in service | MVP |
| `Product` | `id`, `store_id`, `category_id`, `sku`, `name`, `description`, `price_kobo BIGINT`, `currency`, `status`, timestamps, optional `deleted_at` | Unique `(store_id, sku)`; index `(store_id, status)` and `(category_id, status)`; price non-negative | MVP |
| `ProductImage` | `id`, `product_id`, `object_key`, `alt_text`, `position`, `created_at` | Unique `(product_id, position)`; index product; store object key/URL metadata, not image binary | MVP |
| `ProductAttribute` | `id`, `product_id`, `name`, normalized `normalized_name`, `value` | Unique `(product_id, normalized_name)`; descriptive attributes only in MVP | MVP |
| `Warehouse` | `id`, `store_id`, `name`, `status`, timestamps | FK to Store; one default location per store can satisfy MVP | MVP when stock is required |
| `Inventory` | `id`, `warehouse_id`, `product_id`, `available_quantity`, `reserved_quantity` if reservations adopted, `updated_at` | **Approved:** inventory tracked per product and warehouse. Unique `(warehouse_id, product_id)`; check quantities non-negative; atomic conditional updates | MVP |
| `InventoryMovement` | `id`, `warehouse_id`, `product_id`, `quantity_delta`, `reason`, `source_type`, `source_id`, `created_at` | Append-only stock history; use if operational traceability is required at launch | Later/decision |
| `ProductCategory` | `product_id`, `category_id`, `is_primary` | Join table for multi-category assignment; one primary category if introduced | Later |
| `ProductVariant` | `id`, `product_id`, `sku`, `option_values`, `price_kobo`, `status` | Requires product/stock model expansion and unique variant SKU strategy | Later |

## Customer and commerce

| Entity | Core fields | Constraints and notes | Rollout |
|---|---|---|---|
| `Address` | `id`, `user_id`, recipient/contact, `country_code`, region, locality, address lines, postal code, `is_default`, timestamps | **Approved:** launch in Nigeria; explicit country allows future expansion. FK to User; avoid multiple defaults with a transaction/partial unique index; copy address into order snapshot | MVP |
| `Cart` | `id`, `user_id`, timestamps | Unique `user_id` for one current cart; clear/reset after checkout; guest cart later | MVP |
| `CartItem` | `id`, `cart_id`, `product_id`, `quantity`, timestamps | Unique `(cart_id, product_id)`; quantity positive; revalidate current price and stock at checkout | MVP |
| `Wishlist` | `id`, `user_id`, timestamps | Unique `user_id` for one MVP wishlist | MVP |
| `WishlistItem` | `id`, `wishlist_id`, `product_id`, `created_at` | Unique `(wishlist_id, product_id)` | MVP or deferred |
| `Order` | `id`, `customer_id`, `status`, `currency`, `subtotal_kobo`, `discount_kobo`, `shipping_kobo`, `tax_kobo`, `total_kobo`, delivery-address snapshot, timestamps | **Approved:** one checkout may contain products from multiple stores and creates one parent order. Initial `currency` is NGN; all amounts are integer kobo. Index `(customer_id, created_at)` and `(status, created_at)`; preserve snapshot; only server transitions status | MVP |
| `VendorOrder` | `id`, `order_id`, `vendor_id`, `store_id`, `status`, suborder totals/currency as required, timestamps | **Approved:** split a parent order into separate store/vendor suborders. Unique `(order_id, store_id)` when each store has one suborder per checkout; index `(vendor_id, status, created_at)` | MVP |
| `OrderItem` | `id`, `vendor_order_id`, optional `product_id`, product name/SKU snapshot, `unit_price_kobo`, `quantity`, discount/tax allocation, applied `commission_policy_id` and immutable policy/rate/amount snapshot, `line_total_kobo` | Belongs to one vendor/store suborder; index `(vendor_order_id)` and product reference; check quantity > 0; never rewrite commercial snapshots | MVP |
| `Shipment` | `id`, `vendor_order_id`, `status`, optional carrier/tracking reference, timestamps | Associated with its vendor/store suborder; suborder may have multiple shipments when split fulfillment is needed | Later or launch-dependent |
| `ShipmentItem` | `shipment_id`, `order_item_id`, `quantity` | Enables partial/multi-parcel fulfillment; quantity cannot exceed unshipped amount | Later |
| `Review` | `id`, `user_id`, `product_id`, optional `order_item_id`, `rating`, `body`, `status`, timestamps | Rating range constraint; unique purchase-verified review per user/order item as product policy decides | Later |
| `Promotion` | `id`, `name`, `status`, validity window, funding owner, discount rules | Define discount funding/allocation and concurrency before building | Later |
| `Coupon` | `id`, `promotion_id`, normalized `code`, usage limits | Unique normalized code; enforce limits transactionally | Later |
| `CouponRedemption` | `id`, `coupon_id`, `user_id`, `order_id`, `discount_kobo`, `created_at` | Idempotent per order/coupon; index coupon and user for limit checks | Later |

### Order snapshot minimum

An `OrderItem` should be sufficient to reproduce what was sold if the product
or store later changes: product display name, SKU, vendor/store reference,
unit price and currency, quantity, discount/tax allocation, applicable
commission policy/rate and amount, and final line amount. The order stores
subtotal, shipping, tax, discount, total and a delivery-address snapshot.
Snapshots are immutable after order placement except through explicit
adjustment/refund records.

## Payments, ledger, and settlement

| Entity | Core fields | Constraints and notes | Rollout |
|---|---|---|---|
| `Payment` | `id`, `order_id`, `provider` (Paystack for launch), `provider_reference`, `status`, `amount_kobo`, `currency`, `idempotency_key`, `authorized_at`, `captured_at`, timestamps | **Approved:** Paystack is initial payment provider. Unique `(provider, provider_reference)` when present; unique idempotency key in scope; index order/status; future providers remain possible through provider-scoped references | MVP |
| `PaymentEvent` | `id`, `provider`, `provider_event_id`, `payment_id`, event type, received/processed time, processing result | **Approved provider:** Paystack. Unique `(provider, provider_event_id)`; supports webhook deduplication and retry investigation | MVP |
| `Refund` | `id`, `payment_id`, `order_id`, `provider_reference`, `amount_kobo`, `currency`, `status`, reason, timestamps | **Approved:** refund allocations are tracked by order item through `RefundItem`; unique provider refund reference when available; amount > 0 and aggregate refund cannot exceed captured amount | MVP |
| `RefundItem` | `id`, `refund_id`, `order_item_id`, `quantity`, `amount_kobo`, `created_at` | **Approved:** each refund records affected order item(s), quantities, and allocated amount; validate item belongs to the refunded order and cumulative quantity/amount does not exceed refundable remainder | MVP |
| `CommissionPolicy` | `id`, optional `vendor_id`, optional `category_id`, rate and/or fixed terms, effective window, status, timestamps | **Approved:** policies can be configured per vendor or category; snapshot the resolved terms on `OrderItem`. Precedence when both targets match, calculation and effective-date rules remain to be defined; no percentage is assumed | MVP |
| `VendorSettlement` | `id`, `vendor_id`, `status`, `amount_kobo`, `currency`, `idempotency_key`, payout provider/reference, `requested_by_user_id`, `approved_by_user_id`, `approved_at`, decision metadata, processed timestamps | **Approved:** admin approval is required before payout. Planned provider is Paystack subject to supported payout capability. Unique idempotency key and provider payout reference; index `(vendor_id, status, created_at)`; audit every decision | MVP when vendors are paid |
| `SettlementEntry` | `settlement_id`, `ledger_entry_id`, `amount_kobo` | Unique `ledger_entry_id`; MVP settles each payable entry in full, so amount equals its source entry and it cannot be settled twice | MVP when vendors are paid |
| `LedgerAccount` | `id`, optional `vendor_id`, `account_code`, `account_type`, `currency`, `status`, `created_at` | **Approved:** financial records use the double-entry ledger. Unique `(account_code, currency)` and applicable vendor-account uniqueness | MVP for financial operations |
| `LedgerJournal` | `id`, `source_type`, `source_id`, `idempotency_key`, `status`, `currency`, `effective_at`, `posted_at`, optional reversal link | **Approved:** append-only after posting. Unique idempotency key; reverse with a compensating journal; index source | MVP for financial operations |
| `LedgerEntry` | `id`, `journal_id`, `account_id`, `debit_kobo`, `credit_kobo`, `created_at` | **Approved:** immutable ledger entries; exactly one positive side; journal debits equal credits per currency; index `(account_id, created_at)` | MVP for financial operations |
| `ReconciliationRecord` | `id`, provider (Paystack initially), statement/reference, period, status, totals, discrepancy metadata, timestamps | **Approved provider:** Paystack initially. Idempotent statement import; minimize imported sensitive data | Later/operations requirement |
| `VendorBalance` | Not a source-of-truth table | **Approved:** do not introduce a mutable balance as the only evidence. Derive payable balance from posted ledger entries; cache only as rebuildable projection if measured necessary | Not authoritative |

## Audit, notification, and configuration

| Entity | Core fields | Constraints and notes | Rollout |
|---|---|---|---|
| `AuditLog` | `id`, optional `actor_user_id`, actor type, action, target type/ID, occurred time, request/correlation ID, outcome, minimized metadata | Append-only; index `(target_type, target_id, occurred_at)` and actor/time; never include secrets/payment credentials | MVP for sensitive and financial operations |
| `Notification` | `id`, `user_id`, type, payload, read/delivered timestamps, created time | Payload must not carry secrets; index `(user_id, created_at)` | Later |
| `NotificationDelivery` | `id`, `notification_id`, channel, status, provider reference, attempts, timestamps | Needed when actual delivery channels are implemented | Later |
| `PlatformSetting` | `id`, stable key, typed value, updated_by_user_id, timestamps | No secret values; secrets belong in deployment secret manager; audit changes | Later or operational need |
| `OutboxEvent` | `id`, event type, aggregate ID, payload, created/processed time, attempts | Introduce with reliable asynchronous delivery; not required before a consumer exists | Later |

## Status and integrity guidance

Suggested initial state families (final state names and transitions require
product approval):

- `User`: pending verification, active, suspended, anonymized.
- `Vendor`: draft, submitted, under review, approved, rejected, suspended.
- `Product`/`Store`: draft, active, inactive, archived.
- `Order`: pending payment, paid, processing, partially fulfilled, fulfilled,
  cancelled, partially refunded, refunded.
- `Payment`: initiated, pending, authorized (if used), captured, failed,
  cancelled, reversed.
- `Refund`: requested, pending, succeeded, failed, cancelled.
- `Settlement`: requested/pending approval, approved, rejected, processing,
  paid, failed, cancelled.

Use database constraints for stable invariants (uniqueness, valid references,
positive quantities, non-negative amounts, one debit/credit side). Enforce
multi-row invariants such as journal balance and legal state transitions in a
transactional finance/domain service, with restricted database privileges and
tests. Never delete or edit posted ledger entries to force a balance.
