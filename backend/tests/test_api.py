from datetime import date
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine
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

def auth(client, email="student@example.com"):
    credentials = {"email": email, "password": "a-long-test-password"}
    assert client.post("/api/v1/auth/register", json=credentials).status_code == 201
    token = client.post("/api/v1/auth/login", json=credentials).json()["access_token"]
    return {"Authorization": "Bearer " + token}

def plan(client, headers):
    response = client.post("/api/v1/plans", headers=headers, json={"title": "Daily revision", "daily_minutes": 30})
    assert response.status_code == 201
    return response.json()["id"]

def test_health_and_auth(setup):
    client, _ = setup
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").status_code == 200
    assert client.get("/api/v1/plans").status_code == 401
    headers = auth(client)
    assert client.delete("/api/v1/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/v1/plans", headers=headers).status_code == 401

def test_ownership_and_validation(setup):
    client, _ = setup
    owner = auth(client)
    other = auth(client, "other@example.com")
    pid = plan(client, owner)
    assert client.get(f"/api/v1/plans/{pid}", headers=other).status_code == 404
    assert client.post(f"/api/v1/plans/{pid}/shares", headers=other).status_code == 404
    assert client.post("/api/v1/plans", headers=owner, json={"title": " ", "daily_minutes": 0}).status_code == 422
    assert client.get("/api/v1/plans?limit=101", headers=owner).status_code == 422

def test_study_idempotency_and_outbox(setup):
    client, factory = setup
    headers = auth(client)
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
    headers = auth(client)
    pid = plan(client, headers)
    link = client.post(f"/api/v1/plans/{pid}/shares", headers=headers).json()
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

def test_expired_credentials_and_cors(setup):
    from datetime import timedelta
    from app.database import Token, now
    client, factory = setup
    headers = auth(client)
    wrong = client.post("/api/v1/auth/login", json={"email": "student@example.com", "password": "wrong-long-password"})
    assert wrong.status_code == 401
    with factory() as session:
        token = session.scalar(select(Token))
        token.expires = now() - timedelta(seconds=1)
        session.commit()
    assert client.get("/api/v1/plans", headers=headers).status_code == 401
    allowed = client.options("/api/v1/plans", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization,Idempotency-Key"})
    assert allowed.status_code == 200
    loopback = client.options("/api/v1/auth/register", headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type"})
    assert loopback.status_code == 200
    denied = client.options("/api/v1/plans", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
    assert denied.status_code == 400

def test_missing_schema_is_not_ready(setup):
    client, factory = setup
    Base.metadata.drop_all(factory.kw["bind"])
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code == 503
