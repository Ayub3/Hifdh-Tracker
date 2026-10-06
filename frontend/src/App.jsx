import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Feather,
  Flame,
  LogOut,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { api } from './api.js';

const emptyPlanForm = { title: '', daily_minutes: 30 };
const today = (() => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
})();

function localDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dateLabel(value, options = { month: 'short', day: 'numeric' }) {
  return localDate(value).toLocaleDateString(undefined, options);
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') {
        await api('/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
      }
      const result = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onAuthenticated(result.access_token, email.trim().toLowerCase());
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup"><span className="brand-mark"><Feather size={20} /></span><span>Hifdh<span className="brand-light">Tracker</span></span></div>
        <div className="story-copy">
          <span className="eyebrow"><Sparkles size={14} /> A little, every day</span>
          <h1>Make room for what matters.</h1>
          <p>A calm place to plan your memorisation, keep your rhythm, and notice how far you have come.</p>
          <div className="story-note"><div className="note-icon"><BookOpen size={18} /></div><div><strong>Small steps add up</strong><span>Your progress, gathered in one place.</span></div><ArrowUpRight size={17} /></div>
        </div>
        <div className="story-footer">A thoughtful companion for your hifdh journey</div>
      </section>

      <section className="auth-panel">
        <div className="auth-mobile-brand"><span className="brand-mark"><Feather size={20} /></span><span>Hifdh<span className="brand-light">Tracker</span></span></div>
        <div className="auth-card">
          <span className="eyebrow">YOUR PERSONAL SPACE</span>
          <h2>{mode === 'login' ? 'Welcome back' : 'Begin your journey'}</h2>
          <p className="auth-subtitle">{mode === 'login' ? 'Sign in to pick up where you left off.' : 'Create an account to start tracking your progress.'}</p>
          <form onSubmit={submit} className="auth-form">
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" autoComplete="email" required minLength={3} maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            <div className="password-label"><label htmlFor="password">Password</label>{mode === 'register' && <span>At least 12 characters</span>}</div>
            <input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="12 characters or more" />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<ArrowUpRight size={17} /></button>
          </form>
          <p className="auth-switch">{mode === 'login' ? 'New here?' : 'Already have an account?'} <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
          <p className="auth-footnote"><CircleHelp size={14} /> Your study history is private to your account.</p>
        </div>
      </section>
    </main>
  );
}

function Modal({ title, subtitle, onClose, children }) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading"><div><span className="eyebrow">HIFDH TRACKER</span><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>
        {children}
      </section>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('hifdh-token') || '');
  const [email, setEmail] = useState(() => localStorage.getItem('hifdh-email') || '');
  const [plans, setPlans] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [sessions, setSessions] = useState([]);
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [planForm, setPlanForm] = useState(emptyPlanForm);
  const [sessionForm, setSessionForm] = useState({ kind: 'memorisation', minutes: 20, verses: 5, studied_on: today });

  const selectedPlan = plans.find((plan) => plan.id === selectedId) || plans[0];
  const username = email.split('@')[0] || 'there';
  const totals = useMemo(() => progress.reduce((sum, item) => ({
    sessions: sum.sessions + item.sessions,
    minutes: sum.minutes + item.minutes,
    verses: sum.verses + item.verses,
  }), { sessions: 0, minutes: 0, verses: 0 }), [progress]);

  async function loadPlans(authToken, preferredId) {
    setError('');
    try {
      const items = await api('/api/v1/plans', { token: authToken });
      setPlans(items);
      setSelectedId((current) => preferredId || (items.some((plan) => plan.id === current) ? current : items[0]?.id || ''));
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    loadPlans(token).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!token || !selectedPlan) {
      setSessions([]);
      setProgress([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      api(`/api/v1/plans/${selectedPlan.id}/sessions`, { token }),
      api(`/api/v1/plans/${selectedPlan.id}/progress`, { token }),
    ]).then(([sessionItems, result]) => {
      if (!cancelled) {
        setSessions(sessionItems);
        setProgress(result.totals);
      }
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });
    return () => { cancelled = true; };
  }, [selectedPlan?.id, token]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function authenticate(authToken, userEmail) {
    localStorage.setItem('hifdh-token', authToken);
    localStorage.setItem('hifdh-email', userEmail);
    setEmail(userEmail);
    setToken(authToken);
  }

  async function logout() {
    try { await api('/api/v1/auth/logout', { method: 'DELETE', token }); } catch { /* Expired sessions are cleared locally too. */ }
    localStorage.removeItem('hifdh-token');
    localStorage.removeItem('hifdh-email');
    setToken('');
    setPlans([]);
    setSelectedId('');
  }

  async function createPlan(event) {
    event.preventDefault();
    try {
      const plan = await api('/api/v1/plans', { method: 'POST', token, body: JSON.stringify({ ...planForm, daily_minutes: Number(planForm.daily_minutes) }) });
      setPlans((items) => [...items, plan]);
      setSelectedId(plan.id);
      setPlanForm(emptyPlanForm);
      setModal('');
      setNotice('Your plan is ready.');
    } catch (requestError) { setError(requestError.message); }
  }

  async function recordSession(event) {
    event.preventDefault();
    if (!selectedPlan) return;
    try {
      await api(`/api/v1/plans/${selectedPlan.id}/sessions`, {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ ...sessionForm, minutes: Number(sessionForm.minutes), verses: Number(sessionForm.verses) }),
      });
      const [sessionItems, result] = await Promise.all([
        api(`/api/v1/plans/${selectedPlan.id}/sessions`, { token }),
        api(`/api/v1/plans/${selectedPlan.id}/progress`, { token }),
      ]);
      setSessions(sessionItems);
      setProgress(result.totals);
      setSessionForm({ kind: 'memorisation', minutes: 20, verses: 5, studied_on: today });
      setModal('');
      setNotice('Study session added. Well done.');
    } catch (requestError) { setError(requestError.message); }
  }

  const lastSevenDays = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - (6 - index));
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      return { key, label: day.toLocaleDateString(undefined, { weekday: 'narrow' }), minutes: 0, isToday: index === 6 };
    });
    sessions.forEach((session) => {
      const day = days.find((item) => item.key === session.studied_on);
      if (day) day.minutes += session.minutes;
    });
    return days;
  }, [sessions]);
  const maxMinutes = Math.max(30, ...lastSevenDays.map((day) => day.minutes));

  if (!token) return <AuthScreen onAuthenticated={authenticate} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand-lockup" href="#home" aria-label="Hifdh Tracker home"><span className="brand-mark"><Feather size={19} /></span><span>Hifdh<span className="brand-light">Tracker</span></span></a>
        <div className="sidebar-section-label">YOUR WORKSPACE <button type="button" className="icon-button tiny" title="Create a memorisation plan" onClick={() => setModal('plan')}><Plus size={16} /></button></div>
        <div className="plan-nav">
          {plans.map((plan) => <button className={`plan-link ${selectedPlan?.id === plan.id ? 'selected' : ''}`} type="button" key={plan.id} onClick={() => setSelectedId(plan.id)}><span className="plan-dot" /><span>{plan.title}</span>{selectedPlan?.id === plan.id && <ChevronDown className="plan-chevron" size={14} />}</button>)}
          {plans.length === 0 && !loading && <p className="sidebar-empty">Your plans will appear here.</p>}
        </div>
        <button className="new-plan-link" type="button" onClick={() => setModal('plan')}><Plus size={16} /> New plan</button>
        <div className="sidebar-bottom">
          <div className="sidebar-quote"><span className="quote-mark">“</span><p>The best deeds are those done consistently, even if they are few.</p><span className="quote-source">SAHIH AL-BUKHARI</span></div>
          <div className="user-row"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><span className="user-meta"><strong>{username}</strong><span>Personal account</span></span><button type="button" className="icon-button logout-button" aria-label="Sign out" title="Sign out" onClick={logout}><LogOut size={16} /></button></div>
        </div>
      </aside>

      <main className="main-area" id="home">
        <header className="topbar"><div className="breadcrumb"><span>My workspace</span><span className="breadcrumb-divider">/</span><strong>{selectedPlan?.title || 'Overview'}</strong></div><div className="topbar-right"><span className="today-label"><CalendarDays size={15} />{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span className="avatar small-avatar">{username.slice(0, 1).toUpperCase()}</span></div></header>

        <div className="content-area">
          <div className="welcome-row"><div><span className="eyebrow"><span className="eyebrow-dot" /> YOUR MEMORISATION SPACE</span><h1>Assalamu alaikum, {username}</h1><p>A steady rhythm is built one session at a time.</p></div>{selectedPlan && <button className="button button-primary" type="button" onClick={() => setModal('session')}><Plus size={17} /> Log a session</button>}</div>

          {error && <div className="alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={17} /></button></div>}
          {loading ? <div className="loading-state"><span className="spinner" />Loading your plans…</div> : !selectedPlan ? (
            <section className="empty-state"><div className="empty-illustration"><BookOpen size={28} /><span><Sparkles size={15} /></span></div><span className="eyebrow">A FRESH PAGE</span><h2>Start with one intention.</h2><p>Create a plan for the portion you are working on and set a daily goal that feels realistic.</p><button className="button button-primary" type="button" onClick={() => setModal('plan')}><Plus size={17} /> Create your first plan</button></section>
          ) : (
            <>
              <section className="focus-banner">
                <div className="focus-copy"><span className="focus-kicker"><Target size={15} /> TODAY'S INTENTION</span><h2>{selectedPlan.title}</h2><p>Keep showing up for the next ayah.</p></div>
                <div className="focus-target"><span className="target-ring"><Clock3 size={22} /></span><span><strong>{selectedPlan.daily_minutes}<small> min</small></strong><span className="target-caption">daily goal</span></span></div>
                <div className="focus-decoration"><span>وَقُل رَّبِّ زِدْنِي عِلْمًا</span><small>MY LORD, INCREASE ME IN KNOWLEDGE</small></div>
              </section>

              <section className="stats-grid" aria-label="Study totals">
                <article className="stat-card"><div className="stat-heading"><span>Time in study</span><span className="stat-icon green"><Clock3 size={17} /></span></div><strong className="stat-value">{totals.minutes}<small> min</small></strong><span className="stat-foot">Across all your sessions</span></article>
                <article className="stat-card"><div className="stat-heading"><span>Verses covered</span><span className="stat-icon yellow"><BookOpen size={17} /></span></div><strong className="stat-value">{totals.verses}</strong><span className="stat-foot">A little further each day</span></article>
                <article className="stat-card"><div className="stat-heading"><span>Sessions logged</span><span className="stat-icon coral"><Flame size={17} /></span></div><strong className="stat-value">{totals.sessions}</strong><span className="stat-foot">Every effort counts</span></article>
              </section>

              <div className="dashboard-grid">
                <section className="panel week-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR RHYTHM</span><h2>This week</h2></div><span className="panel-unit">Minutes studied</span></div><div className="week-chart" role="img" aria-label={`Study minutes over the last seven days: ${lastSevenDays.map((day) => `${day.label} ${day.minutes} minutes`).join(', ')}`}>
                  {lastSevenDays.map((day) => <div className="chart-day" key={day.key}><span className="bar-value">{day.minutes > 0 ? day.minutes : ''}</span><div className="bar-track"><div className={`bar-fill ${day.isToday ? 'today' : ''}`} style={{ height: `${day.minutes ? Math.max(9, (day.minutes / maxMinutes) * 100) : 4}%` }} /></div><span className={day.isToday ? 'day-label today-label-text' : 'day-label'}>{day.label}</span></div>)}
                </div><div className="chart-legend"><span className="legend-dot" /> Study minutes</div></section>

                <section className="panel breakdown-panel"><div className="panel-heading"><div><span className="eyebrow">AT A GLANCE</span><h2>Study mix</h2></div><span className="breakdown-book"><BookOpen size={18} /></span></div>{['memorisation', 'revision'].map((kind) => { const item = progress.find((entry) => entry.kind === kind); return <div className="mix-row" key={kind}><div className="mix-label"><span className={`mix-dot ${kind}`} /><span>{kind === 'memorisation' ? 'Memorisation' : 'Revision'}</span><strong>{item?.sessions || 0}</strong></div><div className="mix-track"><span className={kind} style={{ width: `${totals.sessions ? ((item?.sessions || 0) / totals.sessions) * 100 : 0}%` }} /></div><span className="mix-caption">{item?.minutes || 0} min · {item?.verses || 0} verses</span></div> })}<div className="mix-note"><Sparkles size={15} /><span>Both new learning and revision help your memorisation settle.</span></div></section>
              </div>

              <section className="panel sessions-panel"><div className="panel-heading sessions-heading"><div><span className="eyebrow">YOUR RECENT WORK</span><h2>Study sessions</h2></div><button className="button button-quiet" type="button" onClick={() => setModal('session')}><Plus size={16} /> Add session</button></div>
                {sessions.length === 0 ? <div className="sessions-empty"><div className="mini-empty-icon"><Feather size={18} /></div><span>No sessions yet. Your first one can be small.</span><button type="button" onClick={() => setModal('session')}>Log a session <ArrowUpRight size={14} /></button></div> : <div className="sessions-table"><div className="table-header"><span>TYPE</span><span>DATE</span><span>TIME</span><span>VERSES</span><span>STATUS</span></div>{sessions.slice(0, 6).map((session) => <div className="session-row" key={session.id}><span className="session-type"><span className={`session-type-icon ${session.kind}`} aria-hidden="true">{session.kind === 'memorisation' ? <ArrowUpRight size={14} /> : <RotateCcw size={14} />}</span><strong>{session.kind === 'memorisation' ? 'Memorisation' : 'Revision'}</strong></span><span>{dateLabel(session.studied_on)}</span><span>{session.minutes} min</span><span>{session.verses}</span><span className="complete-tag"><Check size={13} /> Complete</span></div>)}</div>}
              </section>
            </>
          )}
          <footer className="page-footer"><span>One page at a time.</span><span>“And We have certainly made the Quran easy for remembrance.” <em>54:17</em></span></footer>
        </div>
      </main>

      {modal === 'plan' && <Modal title="Create a plan" subtitle="Choose a focus and a daily target that works for you." onClose={() => setModal('')}><form className="modal-form" onSubmit={createPlan}><label htmlFor="plan-title">Plan name</label><input id="plan-title" autoFocus required minLength={1} maxLength={120} value={planForm.title} onChange={(event) => setPlanForm({ ...planForm, title: event.target.value })} placeholder="e.g. Juz Amma revision" /><label htmlFor="daily-minutes">Daily goal</label><div className="input-with-unit"><input id="daily-minutes" type="number" required min={5} max={480} value={planForm.daily_minutes} onChange={(event) => setPlanForm({ ...planForm, daily_minutes: event.target.value })} /><span>minutes per day</span></div><p className="field-hint">Set a goal between 5 and 480 minutes.</p><button className="button button-primary modal-submit" type="submit"><Plus size={17} /> Create plan</button></form></Modal>}
      {modal === 'session' && <Modal title="Log a study session" subtitle={`Record today's effort for ${selectedPlan?.title || 'your plan'}.`} onClose={() => setModal('')}><form className="modal-form" onSubmit={recordSession}><label>Session type</label><div className="segmented-control"><button type="button" className={sessionForm.kind === 'memorisation' ? 'active' : ''} onClick={() => setSessionForm({ ...sessionForm, kind: 'memorisation' })}><ArrowUpRight size={15} /> Memorisation</button><button type="button" className={sessionForm.kind === 'revision' ? 'active' : ''} onClick={() => setSessionForm({ ...sessionForm, kind: 'revision' })}><RotateCcw size={15} /> Revision</button></div><div className="form-columns"><div><label htmlFor="session-minutes">Time spent</label><div className="input-with-unit"><input id="session-minutes" type="number" required min={1} max={480} value={sessionForm.minutes} onChange={(event) => setSessionForm({ ...sessionForm, minutes: event.target.value })} /><span>minutes</span></div></div><div><label htmlFor="session-verses">Verses</label><div className="input-with-unit"><input id="session-verses" type="number" required min={1} max={1000} value={sessionForm.verses} onChange={(event) => setSessionForm({ ...sessionForm, verses: event.target.value })} /><span>covered</span></div></div></div><label htmlFor="session-date">Study date</label><input id="session-date" type="date" required max={today} value={sessionForm.studied_on} onChange={(event) => setSessionForm({ ...sessionForm, studied_on: event.target.value })} /><button className="button button-primary modal-submit" type="submit"><Check size={17} /> Save session</button></form></Modal>}
      {notice && <div className="toast" role="status"><span className="toast-check"><Check size={14} /></span>{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    </div>
  );
}

export default App;