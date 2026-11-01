# Pedirr

Sports content requests for Sportarr. The project is under active implementation; this revision delivers the deployment foundation, authentication, and user administration APIs; remaining features are tracked in docs/progress.md.

## Development

Requires Node.js 22 and Docker Compose. Run `npm ci`, `npm run db:generate`, `npm run check`, `npm run build`, and `npm test`.

## Docker

Copy `.env.example` to `.env`, replace the database password with a long random URL-safe value, then run `docker compose up --build -d`. PostgreSQL and Redis are private to the Compose network. Migrations run before the API and worker start.

- Liveness: `http://localhost:3000/api/v1/health/live`
- Readiness (database, Redis, worker): `http://localhost:3000/api/v1/health/ready`
- API documentation: `http://localhost:3000/api/docs`
- OpenAPI: `http://localhost:3000/api/openapi.json`

Use a TLS reverse proxy before exposing the finished application publicly. Persistent data lives in the Compose volumes. Do not use `docker compose down -v` unless you intend to delete it.

See [API research](docs/api-research.md), [architecture](docs/architecture.md), and [implementation status](docs/progress.md).

## Initial administrator

After migrations, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell and run:

```sh
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD app node apps/server/dist/bootstrap-admin.js
```

The password must be 12-128 characters. The command refuses to run if an administrator already exists. Registration starts disabled. Administrators can create users with POST `/api/v1/admin/users`, list users with GET `/api/v1/admin/users?page=1`, and update roles, active status, or auto-approval with PATCH `/api/v1/admin/users/{id}`. Disabling or changing a role revokes existing sessions. The last active administrator cannot be disabled or demoted.

Set `APP_ORIGIN` to the exact browser origin, including the port. Set `SESSION_SECRET` to at least 32 cryptographically random characters and keep it identical across API replicas. Session cookies are Secure on HTTPS. Unsafe API requests require an exact Origin header and the `x-csrf-token` obtained from GET `/api/v1/auth/csrf`. Fetch a new token after login, because tokens are bound to the current session. Password changes revoke every existing session.

Authentication tests run an HTTP server with mocked PostgreSQL and Redis. They cover rejected unauthenticated reads, CSRF and Origin checks, cookie attributes, logout revocation, disabled users, closed registration, and rate limiting. Docker readiness separately verifies real database and Redis connectivity and worker heartbeat.

## Approval and registration policies

GET and PATCH `/api/v1/admin/policies` require administrator access. PATCH accepts all three boolean fields: `registrationEnabled`, `userAutoApprove`, and `adminAutoApprove`. All default to false. A user's `autoApprove` field overrides their role when true or false; null inherits the role policy. The request workflow will consume this policy when implemented.

Run the PostgreSQL concurrency test against a running Compose database:

```sh
docker compose run --rm --no-deps app node apps/server/test/integration/users.cjs
```

This test creates an isolated temporary database schema, applies migrations, verifies simultaneous administrator changes and session revocation, and removes the schema afterward. Build the app image first after source changes.
