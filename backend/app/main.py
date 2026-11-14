import hashlib
import json
import os
import secrets
from contextlib import asynccontextmanager
from uuid import uuid4
from urllib.parse import urlparse
from fastapi import FastAPI, Depends, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .database import Base, SessionLocal, Plan, StudySession, Share, Outbox, engine, now
from .schemas import PlanInput, PlanOutput, SessionInput, SessionOutput

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.getenv("AUTO_CREATE_SCHEMA", "").lower() in {"1", "true", "yes"}:
        Base.metadata.create_all(bind=engine)
    yield

app = FastAPI(title="Hifdh Planner API", version="0.1.0", lifespan=lifespan)
origins = [s.strip() for s in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if s.strip()]
if "*" in origins:
    raise ValueError("Use explicit frontend origins")
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["X-Workspace-Key", "Content-Type", "Idempotency-Key"])
frontend = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
if urlparse(frontend).scheme not in {"http", "https"} or not urlparse(frontend).netloc or urlparse(frontend).query or urlparse(frontend).fragment:
    raise ValueError("FRONTEND_URL must be an absolute HTTP(S) URL without query/fragment")
@app.middleware("http")
async def prevent_api_caching(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response

def db():
    with SessionLocal() as session:
        yield session

def current_workspace(x_workspace_key: str = Header(pattern=r"^[0-9a-f]{64}$")):
    # The browser key is a capability. Store only its digest as the owner ID.
    return hashlib.sha256(x_workspace_key.encode()).hexdigest()

def owned_plan(plan_id, workspace_id, session):
    plan = session.get(Plan, plan_id)
    if not plan or plan.workspace_id != workspace_id:
        raise HTTPException(404, "Plan not found")
    return plan

def emit(session, event_type, payload):
    event_id = str(uuid4())
    session.add(Outbox(id=event_id, event_type=event_type, payload=json.dumps({"schema_version": 1, "event_id": event_id, "type": event_type, "occurred_at": now().isoformat(), "data": payload})))

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/ready")
def ready(session: Session = Depends(db)):
    try:
        session.execute(select(Plan.id).limit(1))
    except Exception:
        raise HTTPException(503, "Database unavailable or schema missing")
    return {"status": "ok"}

@app.post("/api/v1/plans", response_model=PlanOutput, status_code=201)
def create_plan(body: PlanInput, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    plan = Plan(id=str(uuid4()), workspace_id=workspace_id, **body.model_dump())
    session.add(plan)
    session.commit()
    return plan

@app.get("/api/v1/plans", response_model=list[PlanOutput])
def plans(limit: int = 50, offset: int = 0, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    if not 1 <= limit <= 100 or offset < 0:
        raise HTTPException(422, "Invalid pagination")
    return session.scalars(select(Plan).where(Plan.workspace_id == workspace_id).order_by(Plan.created_at, Plan.id).limit(limit).offset(offset)).all()

@app.get("/api/v1/plans/{plan_id}", response_model=PlanOutput)
def get_plan(plan_id: str, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    return owned_plan(plan_id, workspace_id, session)

@app.patch("/api/v1/plans/{plan_id}", response_model=PlanOutput)
def update_plan(plan_id: str, body: PlanInput, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    plan = owned_plan(plan_id, workspace_id, session)
    for key, value in body.model_dump().items():
        setattr(plan, key, value)
    session.commit()
    return plan

@app.post("/api/v1/plans/{plan_id}/sessions", response_model=SessionOutput, status_code=201)
def study(plan_id: str, body: SessionInput, idempotency_key: str = Header(min_length=1, max_length=100), workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    owned_plan(plan_id, workspace_id, session)
    values = body.model_dump(mode="json")
    def existing():
        return session.scalar(select(StudySession).where(StudySession.workspace_id == workspace_id, StudySession.request_key == idempotency_key))
    def check(old):
        if old.plan_id != plan_id or any(getattr(old, key) != value for key, value in values.items()):
            raise HTTPException(409, "Idempotency key used for a different request")
        return old
    old = existing()
    if old:
        return check(old)
    record = StudySession(id=str(uuid4()), workspace_id=workspace_id, plan_id=plan_id, request_key=idempotency_key, **values)
    session.add(record)
    emit(session, "study.session_recorded", {"session_id": record.id, "plan_id": plan_id, "workspace_id": workspace_id, **values})
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        old = existing()
        if old:
            return check(old)
        raise
    return record

@app.get("/api/v1/plans/{plan_id}/progress")
def progress(plan_id: str, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    owned_plan(plan_id, workspace_id, session)
    rows = session.execute(select(StudySession.kind, func.count(), func.sum(StudySession.minutes), func.sum(StudySession.verses)).where(StudySession.plan_id == plan_id).group_by(StudySession.kind)).all()
    return {"plan_id": plan_id, "totals": [{"kind": kind, "sessions": count, "minutes": minutes, "verses": verses} for kind, count, minutes, verses in rows]}

@app.post("/api/v1/plans/{plan_id}/shares", status_code=201)
def share(plan_id: str, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    owned_plan(plan_id, workspace_id, session)
    code = secrets.token_urlsafe(16)
    session.add(Share(code=code, plan_id=plan_id))
    session.commit()
    return {"code": code, "path": "/s/" + code}

@app.delete("/api/v1/shares/{code}", status_code=204)
def revoke(code: str, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    link = session.get(Share, code)
    if not link:
        raise HTTPException(404, "Share not found")
    owned_plan(link.plan_id, workspace_id, session)
    link.revoked = 1
    session.commit()
    return Response(status_code=204)

@app.get("/s/{code}")
def redirect(code: str, session: Session = Depends(db)):
    link = session.get(Share, code)
    if not link or link.revoked:
        raise HTTPException(404, "Share not found")
    emit(session, "share.clicked", {"code": code, "plan_id": link.plan_id})
    session.commit()
    return RedirectResponse(frontend + "/shared/" + code, status_code=302, headers={"Cache-Control": "no-store"})

@app.get("/api/v1/public/shares/{code}")
def public_share(code: str, session: Session = Depends(db)):
    link = session.get(Share, code)
    if not link or link.revoked:
        raise HTTPException(404, "Share not found")
    plan = session.get(Plan, link.plan_id)
    # Explicit opt-in shares reveal only the template, never identity or study history.
    return {"title": plan.title, "daily_minutes": plan.daily_minutes}


@app.get("/api/v1/plans/{plan_id}/sessions", response_model=list[SessionOutput])
def list_sessions(plan_id: str, limit: int = 50, offset: int = 0, workspace_id=Depends(current_workspace), session: Session = Depends(db)):
    owned_plan(plan_id, workspace_id, session)
    if not 1 <= limit <= 100 or offset < 0:
        raise HTTPException(422, "Invalid pagination")
    return session.scalars(select(StudySession).where(StudySession.plan_id == plan_id).order_by(StudySession.studied_on.desc(), StudySession.id).limit(limit).offset(offset)).all()
