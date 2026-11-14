# Hifdh Tracker

A web app for planning daily memorisation, logging study sessions, and reviewing progress.

## MVP architecture

- **S3 + CloudFront:** serves the built React frontend.
- **ECS:** runs the FastAPI backend, which stores plans and sessions in SQLite for now. RDS is not required.
- **Anonymous workspaces:** each browser creates a random 256-bit key, stores it in localStorage, and sends it as `X-Workspace-Key`. The API stores its SHA-256 digest as the workspace owner and isolates plans, sessions, and share management by workspace.

There is no registration, login, password, or logout. Possession of the workspace key grants access: do not share or log it. Clearing site data or changing hostname loses access to that workspace; another browser gets a separate workspace. This is anonymous capability access, not verified account identity or account recovery.

Plans and sessions are now saved by the API, rather than in the browser. Previously saved browser-only data remains untouched under `hifdh-workspace-v1`, but is not automatically imported. Existing account tables in an older database remain untouched; anonymous data uses separate `anonymous_plans`, `anonymous_study_sessions`, and `anonymous_shares` tables. Run schema bootstrap once against existing databases to create these tables.

## Run locally

From the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cd backend
python -m app.migrate
uvicorn app.main:app --reload
```

In another terminal, from the repository root:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. The default API URL is `http://localhost:8000`. Set `VITE_API_URL` in `frontend/.env.local` to override it; see `frontend/.env.example`. Vite embeds this URL at build time.

Alternatively, `docker compose up --build` from the repository root starts the backend at port 8000 and creates the schema automatically. Its named volume keeps SQLite data between local container replacements. Run the frontend separately as above.

## Verify

From `backend/`:

```sh
../.venv/bin/python -m pytest -q
```

From `frontend/`:

```sh
node --test tests/api.test.js
npm run build
npm run preview
```

The backend must also be running when using the frontend preview. If you call it directly across origins, add the preview origin (usually `http://localhost:4173`) to backend `CORS_ORIGINS` before starting the API.

## Deploy

See [the AWS deployment guide](docs/aws-static-deployment.md) for the S3/CloudFront frontend and ECS/SQLite API setup. Upload only `frontend/dist/` contents to S3; deploy the backend Docker image separately.

For an ECS/Fargate demo using task-local SQLite, keep one task and accept that stopping or replacing it resets the database. The local Compose volume does not provide persistent storage on ECS. Use durable database storage before relying on server data surviving deployments or scaling to multiple tasks.
