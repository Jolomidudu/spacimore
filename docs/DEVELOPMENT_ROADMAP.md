# Development Roadmap

Build the marketplace in small, verifiable phases. This roadmap describes
planned work; it does not add application features or mock implementations to
the initial repository foundation.

## Phase 1: Repository foundation

- Establish the pnpm workspace and Turborepo task orchestration.
- Reserve the web, API, worker, shared-package, documentation, and Docker
  directory structure.
- Document architecture and development direction.

## Phase 2: Application and data foundations

- Scaffold the Next.js web application and NestJS API with strict TypeScript.
- Establish API versioning, Swagger, configuration validation, and baseline
  development checks.
- Configure Neon Cloud PostgreSQL and Prisma, including the initial migration
  workflow.
- Define module boundaries and shared package conventions before adding
  business capabilities.
- Implement against the owner-approved database decisions: Nigeria launch,
  NGN integer-kobo amounts, Paystack payments, and a Paystack payout integration
  only if supported. Preserve explicit country/currency data for future
  expansion, and use an append-only double-entry ledger as the financial
  record.

## Phase 3: Identity and access

- Design shopper, vendor, and administrative identity and permission models.
- Support multiple roles on one user account and vendor onboarding for
  individuals and registered businesses.
- Implement secure authentication, session handling, and server-side
  authorization.
- Add audit practices for security-sensitive actions.

## Phase 4: Vendor and catalog capabilities

- Add vendor onboarding and store management.
- Allow one vendor to own multiple stores.
- Establish product and category management with validation and ownership
  rules.
- Add protected document handling when the storage integration is selected.

## Phase 5: Shopper discovery and purchase

- Deliver storefront browsing and product discovery.
- Implement cart, checkout, payment integration, and order creation with
  Paystack verification, appropriate validation, transactions, and webhook
  verification.
- Support a single parent checkout across stores with separate vendor/store
  suborders, order-item-level refund allocations, and commission terms
  snapshotted from vendor/category configuration.
- Keep financial values in precise non-floating-point representations.

## Phase 6: Fulfillment and marketplace operations

- Add order lifecycle and vendor fulfillment workflows.
- Build administrative and customer-support capabilities, operational
  reporting, and relevant audit trails.
- Require an auditable administrative approval before vendor settlements are
  submitted for payout.
- Introduce background jobs through the reserved worker directory only when
  asynchronous processing is required.

## Phase 7: Production readiness and expansion

- Improve observability, reliability, accessibility, performance, and security.
- Add infrastructure such as caching and search when justified by measured
  needs.
- Prepare the stable, versioned API for future Flutter clients.

Each phase should have explicit acceptance criteria, tests, and any required
database migrations before moving dependent work into production.
