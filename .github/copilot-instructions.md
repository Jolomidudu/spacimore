
# Spacimore - GitHub Copilot Instructions

## Project Overview
Spacimore is a multi-vendor e-commerce marketplace inspired by
large-scale marketplaces such as Jumia.

The platform will support:
- Shoppers
- Vendors and vendor stores
- Marketplace administrators
- Operations and customer support teams

The initial release is a web application. Flutter mobile
applications will be developed later using the same backend API.

## Architecture
Use a monorepo architecture.

apps/
  web/       Next.js frontend
  api/       NestJS backend
  worker/    Background jobs (introduced later)

packages/
  shared-types/
  validators/
  config/

## Technology Stack

Frontend:
- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Lucide React
- React Hook Form
- Zod
- TanStack Query
- Zustand

Backend:
- NestJS
- TypeScript
- REST API
- Swagger / OpenAPI
- Prisma ORM
- PostgreSQL

Infrastructure:
- Redis
- BullMQ
- Cloudflare R2
- Meilisearch
- GitHub Actions

Hosting:
- Vercel for Next.js
- Render for NestJS
- Managed PostgreSQL

## Engineering Principles

1. Use strict TypeScript.
2. Prefer modular, maintainable architecture.
3. Keep frontend and backend responsibilities separate.
4. Business logic belongs in the backend.
5. Never expose secrets in frontend code.
6. Validate all API inputs.
7. Use DTOs in NestJS.
8. Use Zod for frontend form validation.
9. Use reusable components.
10. Avoid unnecessary dependencies.
11. Write maintainable, readable code.
12. Never use mock data in production features.
13. Do not introduce microservices prematurely.
14. Use database migrations for schema changes.
15. Never store financial amounts using floating-point types.
16. Use appropriate database transactions for financial operations.
17. Implement role and permission checks on the backend.

## API Conventions

All endpoints must be versioned:

/api/v1/

Use appropriate HTTP methods and status codes.

Document endpoints using Swagger.

## Security

- Hash passwords using Argon2id.
- Use secure HttpOnly cookies for browser sessions.
- Implement refresh token rotation.
- Validate user permissions on the server.
- Protect sensitive vendor documents.
- Verify payment webhooks.
- Maintain audit logs for important actions.

## Development Workflow

- Implement features in small phases.
- Inspect existing code before modifying it.
- Do not overwrite working implementations unnecessarily.
- Run tests and type checks after changes.
- Explain important architectural decisions.
- Do not install unnecessary packages.
- Ask before introducing major architectural changes.

## Important Rule

Do not generate the entire marketplace in one operation.

Implement only the feature explicitly requested, following
the agreed development roadmap.
