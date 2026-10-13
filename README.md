# Hifdh Tracker

A small web app for planning daily memorisation, logging study sessions, and reviewing progress.

## Run locally

Use two terminal tabs from the `Hifdh-Tracker` project directory.

### 1. Start the backend

```sh
cd backend
source ../.venv/bin/activate
python -m app.migrate
uvicorn app.main:app --reload
```

The API runs at `http://localhost:8000`; its interactive docs are at `http://localhost:8000/docs`.

If the virtual environment or dependencies are not set up yet:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
```

### 2. Start the frontend

```sh
cd frontend
npm install
npm run dev
```

Open the URL Vite prints, normally `http://localhost:5173`. Create an account in the app to get started. The frontend calls the API at `http://localhost:8000` by default; set `VITE_API_URL` in `frontend/.env.local` to use another API URL.

The API permits the default Vite origin. If you change the frontend port or hostname, set `CORS_ORIGINS` for the backend to include that exact origin and set `FRONTEND_URL` to the frontend base URL.

### Run the backend with Docker Compose

From the project root, start the backend container. Local Compose enables automatic initial schema creation during FastAPI startup:

```sh
docker-compose up
```

If the image needs rebuilding after Dockerfile or dependency changes, run `docker-compose up --build`. In another terminal, run the frontend as above and open `http://localhost:5173`. It calls the containerized API at `http://localhost:8000`. Compose stores the local SQLite database in a named volume; `docker-compose down` keeps that data, while `docker-compose down --volumes` deletes it. The modern equivalent command is `docker compose` (with a space).

## Run backend tests

```sh
cd backend
source ../.venv/bin/activate
pytest
```

