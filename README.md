# Spacimore

Spacimore is a multi-vendor e-commerce marketplace for shoppers, vendors, and
the teams that operate and support the platform. This repository is the
foundation for its web application and backend, organized as a pnpm workspace
with Turborepo.

## Repository layout

- `apps/web` — Next.js web application (to be scaffolded)
- `apps/api` — NestJS REST API and modular monolith (to be scaffolded)
- `apps/worker` — reserved for background job processing when needed
- `packages/shared-types` — types shared across workspace applications
- `packages/validators` — shared input validation schemas
- `packages/config` — shared project configuration
- `docs` — architecture, database, API, and product documentation
- `infrastructure/docker` — reserved for Docker assets

The application directories are workspace placeholders; no application
features or mock implementations have been added. See
[the system architecture](./docs/architecture/SYSTEM_ARCHITECTURE.md) and
[the development roadmap](./docs/DEVELOPMENT_ROADMAP.md) for the approved
architecture and planned phases.

## Workspace setup

Install dependencies from the repository root with `pnpm install`. To confirm
pnpm recognizes the workspace packages, run `pnpm -r list --depth -1`.
Turborepo task commands are available as packages gain their corresponding
scripts; see the root `package.json`.
