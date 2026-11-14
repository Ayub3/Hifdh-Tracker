from datetime import date
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine
import app.main as main_module
from app.main import app, db
from app.database import Base, Outbox, StudySession

@pytest.fixture
def setup():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    def override():
        with factory() as session:
            yield session
    app.dependency_overrides[db] = override
    with TestClient(app) as client:
        yield client, factory
    app.dependency_overrides.clear()
    engine.dispose()

def workspace(key="a" * 64):
    return {"X-Workspace-Key": key}

def test_local_schema_bootstrap(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    monkeypatch.setattr(main_module, "engine", engine)
    monkeypatch.setenv("AUTO_CREATE_SCHEMA", "true")
    with TestClient(app):
        assert inspect(engine).has_table("anonymous_plans")
    engine.dispose()

def plan(client, headers):
    response = client.post("/api/v1/plans", headers=headers, json={"title": "Daily revision", "daily_minutes": 30})
    assert response.status_code == 201
    return response.json()["id"]

def test_health_and_no_login(setup):
    client, _ = setup
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").status_code == 200
    assert client.get("/api/v1/plans").status_code == 422
    assert client.get("/api/v1/plans", headers=workspace()).json() == []
    assert client.get("/api/v1/plans", headers={"X-Workspace-Key": "guess"}).status_code == 422
    for route in ["register", "login", "logout"]:
        assert client.post("/api/v1/auth/" + route, json={}).status_code == 404
    assert client.get("/api/v1/plans", headers=workspace()).headers["cache-control"] == "no-store"

def test_ownership_and_validation(setup):
    client, _ = setup
    owner = workspace()
    other = workspace("b" * 64)
    pid = plan(client, owner)
    assert client.get("/api/v1/plans", headers=other).json() == []
    assert client.get(f"/api/v1/plans/{pid}", headers=owner).status_code == 200
    assert client.get(f"/api/v1/plans/{pid}", headers=other).status_code == 404
    assert client.get(f"/api/v1/plans/{pid}/sessions", headers=other).status_code == 404
    assert client.get(f"/api/v1/plans/{pid}/progress", headers=other).status_code == 404
    assert client.patch(f"/api/v1/plans/{pid}", headers=other, json={"title": "Changed", "daily_minutes": 30}).status_code == 404
    assert client.post(f"/api/v1/plans/{pid}/shares", headers=other).status_code == 404
    assert client.post("/api/v1/plans", headers=owner, json={"title": " ", "daily_minutes": 0}).status_code == 422
    assert client.get("/api/v1/plans?limit=101", headers=owner).status_code == 422

def test_study_idempotency_and_outbox(setup):
    client, factory = setup
    headers = workspace()
    pid = plan(client, headers)
    body = {"kind": "revision", "minutes": 20, "verses": 10, "studied_on": date.today().isoformat()}
    path = f"/api/v1/plans/{pid}/sessions"
    assert client.post(path, json=body, headers=headers).status_code == 422
    headers["Idempotency-Key"] = "study-001"
    first = client.post(path, json=body, headers=headers)
    assert first.status_code == 201
    assert client.post(path, json=body, headers=headers).json() == first.json()
    assert client.post(path, json={**body, "minutes": 25}, headers=headers).status_code == 409
    assert client.get(f"/api/v1/plans/{pid}/progress", headers=headers).json()["totals"] == [{"kind": "revision", "sessions": 1, "minutes": 20, "verses": 10}]
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(StudySession)) == 1
        assert session.scalar(select(func.count()).select_from(Outbox)) == 1

def test_share_click_and_revocation(setup):
    client, factory = setup
    headers = workspace()
    pid = plan(client, headers)
    link = client.post(f"/api/v1/plans/{pid}/shares", headers=headers).json()
    assert client.delete("/api/v1/shares/" + link["code"], headers=workspace("b" * 64)).status_code == 404
    response = client.get(link["path"], follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"].endswith("/shared/" + link["code"])
    assert response.headers["cache-control"] == "no-store"
    public = client.get("/api/v1/public/shares/" + link["code"]).json()
    assert public == {"title": "Daily revision", "daily_minutes": 30}
    with factory() as session:
        event = session.scalar(select(Outbox))
        assert event.event_type == "share.clicked"
        assert event.published_at is None
    assert client.delete("/api/v1/shares/" + link["code"], headers=headers).status_code == 204
    assert client.get(link["path"]).status_code == 404
    assert client.get("/api/v1/public/shares/" + link["code"]).status_code == 404

def test_workspace_cors(setup):
    client, _ = setup
    allowed = client.options("/api/v1/plans", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-Workspace-Key,Idempotency-Key,Content-Type"})
    assert allowed.status_code == 200
    loopback = client.options("/api/v1/plans", headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-Workspace-Key,Content-Type"})
    assert loopback.status_code == 200
    denied = client.options("/api/v1/plans", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
    assert denied.status_code == 400

def test_missing_schema_is_not_ready(setup):
    client, factory = setup
    Base.metadata.drop_all(factory.kw["bind"])
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code == 503

def test_workspace_digest_and_idempotency_isolation(setup):
    import hashlib
    from app.database import Plan
    client, factory = setup
    first, second = workspace(), workspace("b" * 64)
    pid = plan(client, first)
    other_pid = plan(client, second)
    body = {"kind": "revision", "minutes": 20, "verses": 10, "studied_on": date.today().isoformat()}
    assert client.post(f"/api/v1/plans/{pid}/sessions", headers={**second, "Idempotency-Key": "same"}, json=body).status_code == 404
    for plan_id, headers in [(pid, first), (other_pid, second)]:
        assert client.post(f"/api/v1/plans/{plan_id}/sessions", headers={**headers, "Idempotency-Key": "same"}, json=body).status_code == 201
    with factory() as session:
        assert session.get(Plan, pid).workspace_id == hashlib.sha256(("a" * 64).encode()).hexdigest()
        assert session.scalar(select(func.count()).select_from(StudySession)) == 2

def test_bootstrap_preserves_legacy_account_data():
    from sqlalchemy import text
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password TEXT)"))
        connection.execute(text("INSERT INTO users VALUES ('legacy-id', 'old@example.com', 'old-hash')"))
    Base.metadata.create_all(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT email FROM users WHERE id = 'legacy-id'")).scalar() == "old@example.com"
    assert inspect(engine).has_table("anonymous_plans")
    engine.dispose()
