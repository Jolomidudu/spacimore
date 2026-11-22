# Entity Relationships

This document shows proposed logical relationships, not a deployed schema.
`PK` means primary key; `FK` means foreign key. UUIDs are assumed for
identifiers. The initial schema remains in one PostgreSQL database and one
NestJS modular monolith.

The owner-approved MVP launches in Nigeria with NGN/kobo and Paystack, with
future multi-country support kept possible through explicit country and
currency fields. Vendor settlements require admin approval. See
[Database Architecture](./DATABASE_ARCHITECTURE.md) for all approved
decisions and remaining implementation details.

## Identity, vendors, and catalogue

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
        string password_hash
        datetime created_at
    }
    ROLE {
        uuid id PK
        string code UK
    }
    USER_ROLE {
        uuid user_id PK, FK
        uuid role_id PK, FK
        datetime assigned_at
    }
    VENDOR {
        uuid id PK
        uuid owner_user_id FK, UK
        string onboarding_type
        string status
    }
    VENDOR_VERIFICATION {
        uuid id PK
        uuid vendor_id FK
        string status
        string document_object_key
    }
    STORE {
        uuid id PK
        uuid vendor_id FK
        string slug UK
        string status
    }
    CATEGORY {
        uuid id PK
        uuid parent_id FK
        string slug UK
    }
    PRODUCT {
        uuid id PK
        uuid store_id FK
        uuid category_id FK
        string sku
        string name
        bigint price_kobo
        string status
    }
    PRODUCT_IMAGE {
        uuid id PK
        uuid product_id FK
        string object_key
        int position
    }
    PRODUCT_ATTRIBUTE {
        uuid id PK
        uuid product_id FK
        string name
        string value
    }
    WAREHOUSE {
        uuid id PK
        uuid store_id FK
        string name
    }
    INVENTORY {
        uuid id PK
        uuid warehouse_id FK
        uuid product_id FK
        int available_quantity
    }

    USER ||--o{ USER_ROLE : has
    ROLE ||--o{ USER_ROLE : assigned
    USER ||--o| VENDOR : owns
    VENDOR ||--o{ VENDOR_VERIFICATION : undergoes
    VENDOR ||--o{ STORE : owns
    STORE ||--o{ PRODUCT : lists
    CATEGORY o|--o{ CATEGORY : parent_of
    CATEGORY ||--o{ PRODUCT : classifies
    PRODUCT ||--o{ PRODUCT_IMAGE : displays
    PRODUCT ||--o{ PRODUCT_ATTRIBUTE : describes
    STORE ||--o{ WAREHOUSE : operates
    WAREHOUSE ||--o{ INVENTORY : tracks
    PRODUCT ||--o{ INVENTORY : stocked_as
```

In the MVP, a vendor has one owner user; a user may own zero or one vendor.
Vendor staff/membership is intentionally a later join model. A product has one
primary category; a category may have a parent category. Inventory is separate
from product descriptions and is unique for each warehouse/product pair.

## Customer, checkout, and fulfillment

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
    }
    ADDRESS {
        uuid id PK
        uuid user_id FK
        string country_code
        string recipient
        string address_fields
    }
    CART {
        uuid id PK
        uuid user_id FK, UK
        datetime updated_at
    }
    CART_ITEM {
        uuid id PK
        uuid cart_id FK
        uuid product_id FK
        int quantity
    }
    WISHLIST {
        uuid id PK
        uuid user_id FK, UK
    }
    WISHLIST_ITEM {
        uuid id PK
        uuid wishlist_id FK
        uuid product_id FK
    }
    ORDER {
        uuid id PK
        uuid customer_id FK
        string status
        string currency
        bigint total_kobo
        json shipping_address_snapshot
    }
    VENDOR_ORDER {
        uuid id PK
        uuid order_id FK
        uuid vendor_id FK
        uuid store_id FK
        string status
    }
    ORDER_ITEM {
        uuid id PK
        uuid vendor_order_id FK
        uuid product_id FK
        uuid store_id FK
        string product_name_snapshot
        bigint unit_price_kobo
        int quantity
        bigint commission_kobo
    }
    PAYMENT {
        uuid id PK
        uuid order_id FK
        string provider "Paystack"
        string provider_reference
        string status
        bigint amount_kobo
    }
    REFUND {
        uuid id PK
        uuid payment_id FK
        uuid order_id FK
        string provider_reference
        bigint amount_kobo
        string status
    }
    REFUND_ITEM {
        uuid id PK
        uuid refund_id FK
        uuid order_item_id FK
        int quantity
        bigint amount_kobo
    }
    SHIPMENT {
        uuid id PK
        uuid vendor_order_id FK
        string status
        string tracking_reference
    }

    USER ||--o{ ADDRESS : saves
    USER ||--o| CART : uses
    CART ||--o{ CART_ITEM : contains
    PRODUCT ||--o{ CART_ITEM : selected
    USER ||--o| WISHLIST : owns
    WISHLIST ||--o{ WISHLIST_ITEM : contains
    PRODUCT ||--o{ WISHLIST_ITEM : saved
    USER ||--o{ ORDER : places
    ORDER ||--|{ VENDOR_ORDER : groups_by_vendor_store
    VENDOR ||--o{ VENDOR_ORDER : fulfills
    STORE ||--o{ VENDOR_ORDER : fulfills_from
    VENDOR_ORDER ||--|{ ORDER_ITEM : contains
    PRODUCT o|--o{ ORDER_ITEM : source_product
    ORDER ||--o{ PAYMENT : attempts
    PAYMENT ||--o{ REFUND : refunded_by
    ORDER ||--o{ REFUND : has_refund
    REFUND ||--|{ REFUND_ITEM : allocates
    ORDER_ITEM ||--o{ REFUND_ITEM : refunded_item
    VENDOR_ORDER ||--o{ SHIPMENT : fulfilled_by
```

The order’s address is a snapshot, not a live join to an editable customer
address. One parent order can have products from multiple stores; `VendorOrder`
groups the items by store/vendor for fulfillment while payment applies to the
parent checkout. The order item retains product, price, quantity,
store/vendor, commission, and discount snapshots so historical orders remain
explainable after catalogue changes or deletion. A nullable `product_id` may
be retained for reference if catalogue deletion/anonymization is allowed;
snapshots remain authoritative for the order. `RefundItem` records each
refunded order item, quantity, and allocated refund amount.

## Financial ledger and settlement

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
    }
    VENDOR {
        uuid id PK
    }
    STORE {
        uuid id PK
        uuid vendor_id FK
    }
    ORDER {
        uuid id PK
        string currency
    }
    VENDOR_ORDER {
        uuid id PK
        uuid order_id FK
        uuid vendor_id FK
        uuid store_id FK
    }
    ORDER_ITEM {
        uuid id PK
        uuid vendor_order_id FK
        uuid commission_policy_id FK
        bigint commission_kobo
    }
    COMMISSION_POLICY {
        uuid id PK
        uuid vendor_id FK
        uuid category_id FK
        string status
    }
    CATEGORY {
        uuid id PK
        string slug UK
    }
    PAYMENT {
        uuid id PK
        uuid order_id FK
        string provider "Paystack"
        bigint amount_kobo
        string provider_reference
    }
    REFUND {
        uuid id PK
        uuid payment_id FK
        bigint amount_kobo
    }
    REFUND_ITEM {
        uuid id PK
        uuid refund_id FK
        uuid order_item_id FK
        int quantity
        bigint amount_kobo
    }
    LEDGER_ACCOUNT {
        uuid id PK
        uuid vendor_id FK
        string account_type
        string currency
    }
    LEDGER_JOURNAL {
        uuid id PK
        string source_type
        uuid source_id
        string idempotency_key UK
        datetime posted_at
    }
    LEDGER_ENTRY {
        uuid id PK
        uuid journal_id FK
        uuid account_id FK
        bigint debit_kobo
        bigint credit_kobo
    }
    SETTLEMENT {
        uuid id PK
        uuid vendor_id FK
        uuid approved_by_user_id FK
        datetime approved_at
        string status
        bigint amount_kobo
        string payout_provider "Paystack if supported"
        string payout_reference
    }
    SETTLEMENT_ENTRY {
        uuid settlement_id PK, FK
        uuid ledger_entry_id PK, FK
    }
    AUDIT_LOG {
        uuid id PK
        uuid actor_user_id FK
        string target_type
        uuid target_id
        string action
        datetime occurred_at
    }

    VENDOR ||--o{ STORE : owns
    ORDER ||--|{ VENDOR_ORDER : splits_into
    VENDOR ||--o{ VENDOR_ORDER : fulfills
    STORE ||--o{ VENDOR_ORDER : fulfills_from
    VENDOR_ORDER ||--|{ ORDER_ITEM : contains
    ORDER ||--o{ PAYMENT : paid_through
    CATEGORY ||--o{ COMMISSION_POLICY : targets
    VENDOR ||--o{ COMMISSION_POLICY : targets
    COMMISSION_POLICY o|--o{ ORDER_ITEM : snapshotted_on
    ORDER ||--o{ PAYMENT : paid_through
    PAYMENT ||--o{ REFUND : reversed_by
    REFUND ||--|{ REFUND_ITEM : allocates
    ORDER_ITEM ||--o{ REFUND_ITEM : refunded_item
    VENDOR ||--o{ LEDGER_ACCOUNT : owns_payable_account
    LEDGER_JOURNAL ||--|{ LEDGER_ENTRY : posts
    LEDGER_ACCOUNT ||--o{ LEDGER_ENTRY : receives
    VENDOR ||--o{ SETTLEMENT : receives
    SETTLEMENT ||--|{ SETTLEMENT_ENTRY : allocates
    LEDGER_ENTRY ||--o| SETTLEMENT_ENTRY : included_once
    USER o|--o{ SETTLEMENT : approves
    ORDER o|--o{ LEDGER_JOURNAL : source
    PAYMENT o|--o{ LEDGER_JOURNAL : source
    REFUND o|--o{ LEDGER_JOURNAL : source
    SETTLEMENT o|--o{ LEDGER_JOURNAL : source
    USER o|--o{ AUDIT_LOG : performs
```

`SETTLEMENT_ENTRY` is an allocation/link table, not a second balance. The MVP
links each payable ledger entry to at most one settlement and settles it in
full; partial settlement needs a separately designed allocation model.
In the implemented schema, source references may use typed nullable foreign
keys or a carefully constrained source model; do not use unconstrained
polymorphic IDs for critical integrity without an explicit integrity
strategy. Journals and entries are append-only and must balance per currency.
