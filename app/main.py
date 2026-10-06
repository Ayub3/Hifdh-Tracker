import json
import os
import secrets
from datetime import timedelta, timezone
from uuid import uuid4
from urllib.parse import urlparse
from fastapi import FastAPI, Depends, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .database import SessionLocal, User, Token, Plan, StudySession, Share, Outbox, now
from .schemas import Credentials, PlanInput, PlanOutput, SessionInput, SessionOutput
from .security import hash_password, verify_password, token_digest

# Application startup never performs DDL; run `python -m app.migrate` first.
app = FastAPI(title="Hifdh Planner API", version="0.1.0")
origins = [s.strip() for s in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if s.strip()]
if "*" in origins:
    raise ValueError("Use explicit frontend origins")
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])
frontend = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
if urlparse(frontend).scheme not in {"http", "https"} or not urlparse(frontend).netloc or urlparse(frontend).query or urlparse(frontend).fragment:
    raise ValueError("FRONTEND_URL must be an absolute HTTP(S) URL without query/fragment")
bearer = HTTPBearer(auto_error=False)
dummy_password = hash_password("unused-dummy-password")

def db():
    with SessionLocal() as session:
        yield session

def current_user(auth: HTTPAuthorizationCredentials | None = Depends(bearer), session: Session = Depends(db)):
    token = session.get(Token, token_digest(auth.credentials)) if auth else None
    if not token or token.expires.replace(tzinfo=timezone.utc) <= now():
        raise HTTPException(401, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    return token.user_id

def owned_plan(plan_id, user_id, session):
    plan = session.get(Plan, plan_id)
    if not plan or plan.user_id != user_id:
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

@app.post("/api/v1/auth/register", status_code=201)
def register(body: Credentials, session: Session = Depends(db)):
    user = User(id=str(uuid4()), email=body.email, password=hash_password(body.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "Email already registered")
    return {"id": user.id, "email": user.email}

@app.post("/api/v1/auth/login")
def login(body: Credentials, session: Session = Depends(db)):
    user = session.scalar(select(User).where(User.email == body.email))
    # Execute a password hash even for unknown users to reduce timing differences.
    valid = verify_password(body.password, user.password) if user else verify_password(body.password, dummy_password) and False
    if not valid:
        raise HTTPException(401, "Invalid credentials")
    value = secrets.token_urlsafe(32)
    session.add(Token(digest=token_digest(value), user_id=user.id, expires=now() + timedelta(hours=12)))
    session.commit()
    return {"access_token": value, "token_type": "bearer", "expires_in": 43200}

@app.delete("/api/v1/auth/logout", status_code=204)
def logout(user_id=Depends(current_user), auth=Depends(bearer), session: Session = Depends(db)):
    session.delete(session.get(Token, token_digest(auth.credentials)))
    session.commit()
    return Response(status_code=204)

@app.post("/api/v1/plans", response_model=PlanOutput, status_code=201)
def create_plan(body: PlanInput, user_id=Depends(current_user), session: Session = Depends(db)):
    plan = Plan(id=str(uuid4()), user_id=user_id, **body.model_dump())
    session.add(plan)
    session.commit()
    return plan

@app.get("/api/v1/plans", response_model=list[PlanOutput])
def plans(limit: int = 50, offset: int = 0, user_id=Depends(current_user), session: Session = Depends(db)):
    if not 1 <= limit <= 100 or offset < 0:
        raise HTTPException(422, "Invalid pagination")
    return session.scalars(select(Plan).where(Plan.user_id == user_id).order_by(Plan.created_at, Plan.id).limit(limit).offset(offset)).all()

@app.get("/api/v1/plans/{plan_id}", response_model=PlanOutput)
def get_plan(plan_id: str, user_id=Depends(current_user), session: Session = Depends(db)):
    return owned_plan(plan_id, user_id, session)

@app.patch("/api/v1/plans/{plan_id}", response_model=PlanOutput)
def update_plan(plan_id: str, body: PlanInput, user_id=Depends(current_user), session: Session = Depends(db)):
    plan = owned_plan(plan_id, user_id, session)
    for key, value in body.model_dump().items():
        setattr(plan, key, value)
    session.commit()
    return plan

@app.post("/api/v1/plans/{plan_id}/sessions", response_model=SessionOutput, status_code=201)
def study(plan_id: str, body: SessionInput, idempotency_key: str = Header(min_length=1, max_length=100), user_id=Depends(current_user), session: Session = Depends(db)):
    owned_plan(plan_id, user_id, session)
    values = body.model_dump(mode="json")
    def existing():
        return session.scalar(select(StudySession).where(StudySession.user_id == user_id, StudySession.request_key == idempotency_key))
    def check(old):
        if old.plan_id != plan_id or any(getattr(old, key) != value for key, value in values.items()):
            raise HTTPException(409, "Idempotency key used for a different request")
        return old
    old = existing()
    if old:
        return check(old)
    record = StudySession(id=str(uuid4()), user_id=user_id, plan_id=plan_id, request_key=idempotency_key, **values)
    session.add(record)
    emit(session, "study.session_recorded", {"session_id": record.id, "plan_id": plan_id, "user_id": user_id, **values})
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
def progress(plan_id: str, user_id=Depends(current_user), session: Session = Depends(db)):
    owned_plan(plan_id, user_id, session)
    rows = session.execute(select(StudySession.kind, func.count(), func.sum(StudySession.minutes), func.sum(StudySession.verses)).where(StudySession.plan_id == plan_id).group_by(StudySession.kind)).all()
    return {"plan_id": plan_id, "totals": [{"kind": kind, "sessions": count, "minutes": minutes, "verses": verses} for kind, count, minutes, verses in rows]}

@app.post("/api/v1/plans/{plan_id}/shares", status_code=201)
def share(plan_id: str, user_id=Depends(current_user), session: Session = Depends(db)):
    owned_plan(plan_id, user_id, session)
    code = secrets.token_urlsafe(16)
    session.add(Share(code=code, plan_id=plan_id))
    session.commit()
    return {"code": code, "path": "/s/" + code}

@app.delete("/api/v1/shares/{code}", status_code=204)
def revoke(code: str, user_id=Depends(current_user), session: Session = Depends(db)):
    link = session.get(Share, code)
    if not link:
        raise HTTPException(404, "Share not found")
    owned_plan(link.plan_id, user_id, session)
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
def list_sessions(plan_id: str, limit: int = 50, offset: int = 0, user_id=Depends(current_user), session: Session = Depends(db)):
    owned_plan(plan_id, user_id, session)
    if not 1 <= limit <= 100 or offset < 0:
        raise HTTPException(422, "Invalid pagination")
    return session.scalars(select(StudySession).where(StudySession.plan_id == plan_id).order_by(StudySession.studied_on.desc(), StudySession.id).limit(limit).offset(offset)).all()
