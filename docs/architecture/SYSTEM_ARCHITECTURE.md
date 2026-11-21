# System Architecture

## Approved direction

Spacimore is a pnpm-workspace monorepo orchestrated with Turborepo. The initial
product is a web application backed by a TypeScript REST API. The backend is a
**modular monolith**: one NestJS application and deployment, organized into
well-defined business modules rather than independently deployed services.

PostgreSQL is the relational datastore, accessed through Prisma. Future
infrastructure such as Redis, BullMQ, object storage, and search will be
introduced only when a product or operational requirement calls for it.

## Approved technology stack

- **Web:** Next.js App Router, React, TypeScript, Tailwind CSS, shadcn/ui,
  Lucide React, React Hook Form, Zod, TanStack Query, and Zustand.
- **Backend:** NestJS, TypeScript, REST, Swagger/OpenAPI, Prisma, and
  PostgreSQL.
- **Planned infrastructure:** Redis and BullMQ for background processing,
  Cloudflare R2 for object storage, Meilisearch for search, and GitHub Actions
  for CI/CD.
- **Hosting:** Vercel for the web application, Render for the NestJS API, and
  managed PostgreSQL.

These are approved technologies, not a requirement to install or provision
them all in the repository foundation. Add dependencies and infrastructure as
the corresponding development phase requires them.

## Workspace boundaries

- `apps/web` owns the browser experience. It communicates with the backend
  through the versioned REST API; business rules and authorization remain on
  the server.
- `apps/api` owns API transport, validation, authorization, business workflows,
  and persistence. NestJS modules organize these responsibilities by domain.
- `apps/worker` is reserved for background processing introduced later. If
  needed, it will run jobs for the same application and reuse the backend's
  domain modules and data model; it is not a separate business microservice.
- `packages/shared-types`, `packages/validators`, and `packages/config` hold
  reusable, framework-appropriate contracts, schemas, and configuration.
  They must not become a home for server-side business logic.

## Backend modular monolith

The API is the initial backend application. Its modules should map to cohesive
business capabilities, own their application logic, and expose deliberate
interfaces to other modules. Cross-module dependencies should flow through
those interfaces rather than reaching into another module's internal
implementation. NestJS modules provide structural boundaries, not independent
deployment boundaries.

Modules share the same application lifecycle and PostgreSQL database. Use
Prisma migrations for schema changes and database transactions where a
workflow requires atomic updates, especially for financial operations. Keep
financial amounts out of floating-point representations.

## API and security conventions

- Version REST endpoints under `/api/v1/` and document them with Swagger.
- Validate API inputs and enforce role and permission checks on the server.
- Keep secrets out of browser code. Use secure HttpOnly browser session
  cookies, password hashing with Argon2id, and refresh-token rotation as
  authentication is implemented.
- Protect sensitive vendor documents, verify payment webhooks, and audit
  important actions as the relevant capabilities are introduced.

## Data flow

The web application calls the versioned API. The API validates the request,
applies authorization and domain rules in the appropriate module, and uses
Prisma to access PostgreSQL. External infrastructure integrations belong
behind backend module boundaries. Shared packages may define contracts, but
the backend remains authoritative for business decisions.

## Evolution

Start with the web application and modular NestJS API. Introduce background
processing, caching, object storage, and search incrementally when justified.
Do not split the backend into microservices prematurely. Future Flutter clients
may use the same versioned backend API.
