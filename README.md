# Hifdh Planner backend

A Python/FastAPI backend for private memorisation and revision plans. It runs locally today; Dockerfiles, Terraform, AWS resources, CI/CD and frontend are deliberately left for subsequent work.

Implemented: account registration, expiring/revocable bearer tokens, owner-scoped plans, study sessions, progress totals, opt-in share links, click events and a transactional event outbox. OpenAPI describes the frontend contract at `/docs` and `/openapi.json`. This is an initial backend foundation, not a completed ECS v2 deployment.

## Run locally

Python 3.12 is the tested interpreter. From this directory:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m app.migrate
python -m uvicorn app.main:app --host 127.0.0.1 --port 8080
```

```sh
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

Both return `{"status":"ok"}` after schema creation. `/health` tests process liveness; `/ready` queries a real application table and fails with 503 if the database/schema is unavailable. Configure ALB health checks to use `/ready`.

For the first assignment's port-80 requirement, run the same command with `--port 80`; port binding permissions depend on the OS. For ECS v2 the API uses 8080. The supplied first-project Docker verification has inconsistent ports: `-p 80:80` means curl port 80; `-p 8080:80` means curl port 8080.

SQLite creates `hifdh.db` locally. It is a development convenience and must not be used as persistent storage on ECS or shared across service replicas. PostgreSQL support is configured using:

```sh
export DATABASE_URL='postgresql+psycopg://USER:PASSWORD@HOST:5432/hifdh?sslmode=require'
python -m app.migrate
```

Use runtime secret injection for deployed credentials. Do not commit a real database URL. PostgreSQL compatibility is implemented through SQLAlchemy and psycopg, but has not been integration-tested against a running PostgreSQL server in this workspace.

`python -m app.migrate` bootstraps the initial schema and is repeatable. It does **not** alter existing tables. Before the first schema evolution, introduce reviewed, versioned migrations (e.g. Alembic); run migrations once as a deployment task, never in every web replica's startup.

## Try the product

1. Open `http://localhost:8080/docs`.
2. Register with `POST /api/v1/auth/register` using an email and password of 12–128 characters.
3. Log in using `POST /api/v1/auth/login`. Copy `access_token` into the documentation's **Authorize** control.
4. Create a plan with `POST /api/v1/plans`, e.g. `{"title":"Daily revision","daily_minutes":30}`.
5. Record a session at `/api/v1/plans/{id}/sessions`. Set `Idempotency-Key` to a fresh identifier, and send `{"kind":"revision","minutes":20,"verses":10,"studied_on":"YYYY-MM-DD"}` with today's date or a past date.
6. Read `/api/v1/plans/{id}/progress` and `/api/v1/plans/{id}/sessions`.
7. Create a share at `/api/v1/plans/{id}/shares`. Request its `/s/{code}` path without following redirects to see a 302 and record a click. The destination frontend is intentionally not built yet.
8. Read `/api/v1/public/shares/{code}` to preview the shared template, then revoke it with `DELETE /api/v1/shares/{code}`.

Retry a study submission with the same key and payload to receive the original record; changed payloads receive 409. Keys are unique per user, across their plans. Revision verse totals count practice volume, **not distinct verses memorised**. The backend does not yet model Quran verse ranges, completion schedules, streaks or reminders.

Share links disclose only a plan's title and daily target. Users should avoid personal information in titles they share. Account identity and study history stay private. The app redirects only to its configured frontend, so it cannot be used as an arbitrary open redirect.

## Frontend contract

Future local frontend: `http://localhost:5173`. Backend: `http://localhost:8080`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./hifdh.db` | Local SQLite or deployed PostgreSQL |
| `FRONTEND_URL` | `http://localhost:5173` | Fixed destination for `/s/{code}` redirects |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated, explicit allowed browser origins |

Environment variables are read from the process; `.env.example` is documentation and no dotenv loader is used. In deployment, set HTTPS frontend origins explicitly. Authenticated calls use `Authorization: Bearer <token>`. Tokens expire after 12 hours, are stored hashed in the database and can be revoked by logout. The frontend should keep tokens in memory; a later browser session design should use reviewed secure cookie/CSRF handling if persistent sign-in is needed.

The future frontend needs a `/shared/:code` route that calls the public share endpoint. No frontend source or assets are included. CORS is not an authorization mechanism: owner checks protect private endpoints. List endpoints return at most 100 items and support `limit`/`offset`.

## Current architecture

```mermaid
flowchart LR
    Client[API client / future frontend] --> API[FastAPI planner]
    API --> DB[(Local SQLite / PostgreSQL adapter)]
    DB --> Plans[Accounts, plans, sessions, shares]
    DB --> Outbox[Unpublished durable events]
```

No process currently consumes the outbox. Events are durable but are **not** published to SQS and no asynchronous analytics are calculated yet. SQS, Redis and the Go services are the next application phase, not hidden dependencies needed to run this API.

## How the two ECS projects fit together

**Project 1:** deploy this API as one ECS Fargate service. First complete ClickOps, capture evidence, tear down, then reproduce it with Terraform. Use ECR, ALB, ACM and Route 53. Add PostgreSQL if accounts/plans must survive task replacement; this exceeds the first assignment's minimum but avoids an ephemeral database. Keep the submitted `https://tm.<domain>/health` routed to the API.

A future static frontend can use a private S3 bucket behind CloudFront with Origin Access Control. Keep the API behind ECS/ALB. For a single application origin, CloudFront can route `/api/*` and `/s/*` to the ALB with caching disabled and forward authorization headers; alternatively use a separate API hostname and explicit CORS. Do not rewrite failed API requests to the SPA's index page.

**Project 2:** extend the same product with short share links and click analytics:

| Service | Implementation | Responsibility |
| --- | --- | --- |
| API | Existing Python backend, port 8080 | Planner writes, short share links, redirects, Redis reads and outbox-to-SQS publishing |
| Worker | Future Go process, no inbound port | Consume SQS, deduplicate events, update PostgreSQL analytics |
| Dashboard | Future Go HTTP service, port 8081 | Owner-scoped analytics queries: top links, counts, hourly breakdowns and recent events |

The supplied v2 brief explicitly says provided application code and Python/Go/Go. Confirm that an original Hifdh implementation is accepted. This backend shares plan templates rather than shortening arbitrary external URLs; it demonstrates redirects/click events but is not yet a literal substitute for every supplied URL-shortener endpoint.

```mermaid
flowchart LR
    Browser --> CF[Future CloudFront]
    CF --> S3[Private static frontend]
    Browser --> ALB[HTTPS ALB + regional WAF]
    ALB --> API[Python API /api and /s]
    ALB --> Dash[Go dashboard /analytics]
    API --> PG[(RDS PostgreSQL)]
    API --> Redis[(ElastiCache Redis)]
    API --> Queue[SQS + dead-letter queue]
    Queue --> Worker[Go worker]
    Worker --> PG
    Dash --> PG
```

This diagram is the **target**, not a claim of deployed resources. All three compute services belong to one ECS cluster and private subnets; only the ALB receives public traffic. The worker has no ALB target group. API and dashboard need independent target groups/readiness checks.

### Database decision

Recommend **RDS PostgreSQL**. Users, plans, sessions, links and analytics are relational; transactions also let us persist a business change and its event together. PostgreSQL suits hourly aggregations and reporting without inventing additional access-pattern tables. Trade-offs: database cost, connection limits, migrations and backup operations. DynamoDB could fit a deliberately redesigned access model, but it is not a configuration swap for this schema. Use separate database privileges for the API, worker and read-only dashboard rather than giving all services an administrator login.

Redis should be a cache for public share lookups, never the source of truth. Cache failures should fall back to PostgreSQL. Preserve immediate revocation correctness: validate revocation against the database or implement a reviewed invalidation strategy before caching share authorization. Do not introduce cross-user caches for private endpoints.

### Event contract and delivery

Every outbox payload contains:

```json
{
  "schema_version": 1,
  "event_id": "UUID",
  "type": "share.clicked",
  "occurred_at": "UTC ISO-8601 timestamp",
  "data": {"code": "share-code", "plan_id": "UUID"}
}
```

`study.session_recorded` additionally carries `session_id`, `user_id`, `kind`, `minutes`, `verses`, and `studied_on` inside `data`. Share events deliberately omit email, IP address and user-agent. A click means a request to `/s/{code}`, including bots; it is not a unique-human count.

Future publisher: run a supervised loop inside the API service to preserve the three-service requirement. Claim batches using PostgreSQL row locks/`SKIP LOCKED`, send to SQS, and mark `published_at` only after acknowledgement. A crash between send and mark can duplicate an event. The Go worker must insert a unique `event_id` and update analytics in one transaction; acknowledge SQS only after committing. Retried delivery must not count twice. Use bounded polling/backoff, graceful shutdown, DLQ redrive and metrics for oldest unpublished event, queue age and processing errors. Invalid/future schema versions must not be silently acknowledged.

Without the publisher, pending outbox records will accumulate. Monitor/prune them only after processing is implemented; do not claim successful event delivery from an API health check.

### Networking without NAT

Private tasks need a deliberate endpoint inventory: ECR API/DKR interface endpoints plus S3 gateway access for image layers, CloudWatch Logs, SQS, and whichever secret service the tasks use. Allow endpoint HTTPS only from the relevant task security groups and apply endpoint policies. RDS and Redis use private network connections with restricted security groups. Fargate does not need ECS interface endpoints simply to run. Avoid public registries or runtime package downloads from private tasks. Interface endpoints themselves have costs; no NAT does not mean free networking.

References: [AWS ECR VPC endpoints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html), [Fargate endpoint considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/vpc-endpoints.html), [CloudFront Origin Access Control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

## Deployment workflow design (future infrastructure)

1. PR checks: backend tests, separate Go tests once written, image builds, Terraform fmt/validate/tflint and reviewed plans. Pin shared-module versions. Avoid AWS credentials in untrusted PR jobs.
2. Merge to main triggers an application workflow; also allow `workflow_dispatch`. Use GitHub OIDC with trust scoped to the repository and the protected deployment environment/ref, rather than static AWS keys.
3. Build each service once, tag its ECR image with the commit SHA, scan and record immutable digests. Build in CI; deployed tasks only pull private ECR images.
4. Serialize deployments per environment. Run any backward-compatible database migration once. Use expand/contract changes so old and new tasks can run together; defer destructive schema changes until the old code has been retired.
5. Register task-definition revisions pointing at those exact digests and update the three services in a documented compatibility order. Infrastructure has a separate Terraform workflow with remote encrypted/versioned state, locking and a saved reviewed plan. Avoid having Terraform and application CI independently overwrite task-definition selection; decide and document ownership explicitly.
6. Set rolling deployments to `minimumHealthyPercent=100` and `maximumPercent=200`, with sufficient capacity and preferably at least two replicas for HTTP services. Use ALB readiness checks, graceful shutdown and appropriate deregistration draining. Enable the ECS deployment circuit breaker with rollback. The previous successful deployment must exist for automatic rollback.
7. Wait for each intended task revision to become healthy. An ECS rollback can return a service to stability, so verify the live task-definition/image digest still matches the intended release and fail CI if it does not.
8. Test HTTPS health, authenticated plan writes, share redirect, and eventual owner-visible analytics after a bounded queue-processing wait. Worker readiness requires polling/processing heartbeat and queue metrics; a running process alone proves little.
9. Circuit-breaker rollback covers startup/health failures; use application alarms and an explicit revert to last-good image digests for post-deploy functional failures. Multi-service rollback must preserve version compatibility. Document and rehearse this before claiming zero-downtime release support.

See [AWS deployment configuration](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeploymentConfiguration.html) and [deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).

## Reusable module repository

Build modules after proving the first ClickOps architecture. Extract cohesive primitives: network (subnets/endpoints), ECR, ECS service, ALB, DNS/certificates, PostgreSQL, Redis, queue/DLQ and WAF. Separate the environment's composition from reusable modules. Expose typed inputs and useful outputs, document IAM ownership, include examples, and publish versioned releases. Prefer a small, understood module over a universal abstraction with dozens of switches. Reuse the ECS service module three times in project 2; do not bury application route rules inside it.

## Verification and remaining work

```sh
python -m pytest -q
```

Six tests cover authentication/logout, expired tokens, CORS, validation, ownership isolation, idempotent study writes, matching durable event counts, progress aggregation, share clicks/revocation and readiness failure when the schema is missing. They use isolated SQLite databases. Local Uvicorn was verified with curl on port 8080: both `/health` and `/ready` returned `{"status":"ok"}`. Port 80 binding was attempted and refused by this machine's OS permissions. No Docker, AWS, PostgreSQL integration or live-domain verification has been performed.

Before an internet-facing release: add versioned migrations, account recovery/email verification, login/register abuse controls, structured request/error logs and request IDs, PostgreSQL integration tests, backup/restore verification, and reviewed browser authentication. Custom local authentication is a foundation; a managed identity provider such as Cognito is an alternative worth evaluating before public use. Passwords use salted scrypt; access tokens are random and only their SHA-256 digests are stored.

The Go worker/dashboard, SQS publisher, Redis adapter, Docker/Compose, Terraform, OIDC pipeline, frontend and deployment screenshots remain future work. Capture real evidence once deployed, then tear down billable resources as required by the assignments. No infrastructure or frontend has been generated here.
