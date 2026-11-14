import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Feather,
  Flame,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { api, listAll } from './api.js';

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
  const [plans, setPlans] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const savingRef = useRef(false);
  const sessionRequest = useRef(null);
  const [selectedId, setSelectedId] = useState('');
  const [modal, setModal] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [planForm, setPlanForm] = useState(emptyPlanForm);
  const [sessionForm, setSessionForm] = useState({ kind: 'memorisation', minutes: 20, verses: 5, studied_on: today });

  const selectedPlan = plans.find((plan) => plan.id === selectedId) || plans[0];
  const totals = useMemo(() => progress.reduce((sum, item) => ({
    sessions: sum.sessions + item.sessions,
    minutes: sum.minutes + item.minutes,
    verses: sum.verses + item.verses,
  }), { sessions: 0, minutes: 0, verses: 0 }), [progress]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    listAll('/api/v1/plans').then((items) => {
      if (active) setPlans(items);
    }).catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    setSessions([]);
    setProgress([]);
    if (selectedPlan) {
      Promise.all([
        listAll(`/api/v1/plans/${selectedPlan.id}/sessions`),
        api(`/api/v1/plans/${selectedPlan.id}/progress`),
      ]).then(([items, result]) => {
        if (active) { setSessions(items); setProgress(result.totals); }
      }).catch((err) => { if (active) setError(err.message); });
    }
    return () => { active = false; };
  }, [selectedPlan?.id, refresh]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function createPlan(event) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const title = planForm.title.trim();
      if (!title) throw new Error('Please enter a plan name.');
      const plan = await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({ title, daily_minutes: Number(planForm.daily_minutes) }) });
      setPlans((items) => [...items, plan]);
      setSelectedId(plan.id);
      setPlanForm(emptyPlanForm);
      setModal('');
      setNotice('Your plan is ready.');
    } catch (err) { setError(err.message); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function recordSession(event) {
    event.preventDefault();
    if (!selectedPlan || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const path = `/api/v1/plans/${selectedPlan.id}/sessions`;
    const body = JSON.stringify({ ...sessionForm, minutes: Number(sessionForm.minutes), verses: Number(sessionForm.verses) });
    // Retain the same key when retrying an unchanged request after a lost response.
    if (sessionRequest.current?.body !== body || sessionRequest.current?.path !== path) {
      sessionRequest.current = { body, path, key: crypto.randomUUID() };
    }
    try {
      await api(path, { method: 'POST', body, headers: { 'Idempotency-Key': sessionRequest.current.key } });
      sessionRequest.current = null;
      setSessionForm({ kind: 'memorisation', minutes: 20, verses: 5, studied_on: today });
      setModal('');
      setNotice('Study session added. Well done.');
      setRefresh((value) => value + 1);
    } catch (err) { setError(err.message); }
    finally { savingRef.current = false; setSaving(false); }
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand-lockup" href="#home" aria-label="Hifdh Tracker home"><span className="brand-mark"><Feather size={19} /></span><span>Hifdh<span className="brand-light">Tracker</span></span></a>
        <div className="sidebar-section-label">YOUR WORKSPACE <button type="button" className="icon-button tiny" title="Create a memorisation plan" onClick={() => setModal('plan')}><Plus size={16} /></button></div>
        <div className="plan-nav">
          {plans.map((plan) => <button className={`plan-link ${selectedPlan?.id === plan.id ? 'selected' : ''}`} type="button" key={plan.id} onClick={() => setSelectedId(plan.id)}><span className="plan-dot" /><span>{plan.title}</span>{selectedPlan?.id === plan.id && <ChevronDown className="plan-chevron" size={14} />}</button>)}
          {plans.length === 0 && <p className="sidebar-empty">Your plans will appear here.</p>}
        </div>
        <button className="new-plan-link" type="button" onClick={() => setModal('plan')}><Plus size={16} /> New plan</button>
        <div className="sidebar-bottom">
          <div className="sidebar-quote"><span className="quote-mark">“</span><p>The best deeds are those done consistently, even if they are few.</p><span className="quote-source">SAHIH AL-BUKHARI</span></div>
          <div className="user-row"><span className="avatar"><BookOpen size={18} /></span><span className="user-meta"><strong>My workspace</strong><span>Anonymous workspace</span></span></div>
        </div>
      </aside>

      <main className="main-area" id="home">
        <header className="topbar"><div className="breadcrumb"><span>My workspace</span><span className="breadcrumb-divider">/</span><strong>{selectedPlan?.title || 'Overview'}</strong></div><div className="topbar-right"><span className="today-label"><CalendarDays size={15} />{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span className="avatar small-avatar"><BookOpen size={16} /></span></div></header>

        <div className="content-area">
          <div className="welcome-row"><div><span className="eyebrow"><span className="eyebrow-dot" /> YOUR MEMORISATION SPACE</span><h1>Assalamu alaikum</h1><p>No sign-in needed. Keep this browser’s site data to retain access to your workspace.</p></div>{selectedPlan && <button className="button button-primary" type="button" onClick={() => setModal('session')}><Plus size={17} /> Log a session</button>}</div>

          {error && <div className="alert" role="alert"><span>{error}</span><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry</button><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={17} /></button></div>}
          {loading ? <div className="loading-state">Loading your plans…</div> : !selectedPlan ? (
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

      {modal === 'plan' && <Modal title="Create a plan" subtitle="Choose a focus and a daily target that works for you." onClose={() => setModal('')}><form className="modal-form" onSubmit={createPlan}>{error && <p className="form-error" role="alert">{error}</p>}<label htmlFor="plan-title">Plan name</label><input id="plan-title" autoFocus required minLength={1} maxLength={120} value={planForm.title} onChange={(event) => setPlanForm({ ...planForm, title: event.target.value })} placeholder="e.g. Juz Amma revision" /><label htmlFor="daily-minutes">Daily goal</label><div className="input-with-unit"><input id="daily-minutes" type="number" required min={5} max={480} value={planForm.daily_minutes} onChange={(event) => setPlanForm({ ...planForm, daily_minutes: event.target.value })} /><span>minutes per day</span></div><p className="field-hint">Set a goal between 5 and 480 minutes.</p><button className="button button-primary modal-submit" type="submit" disabled={saving}><Plus size={17} /> Create plan</button></form></Modal>}
      {modal === 'session' && <Modal title="Log a study session" subtitle={`Record today's effort for ${selectedPlan?.title || 'your plan'}.`} onClose={() => setModal('')}><form className="modal-form" onSubmit={recordSession}>{error && <p className="form-error" role="alert">{error}</p>}<label>Session type</label><div className="segmented-control"><button type="button" className={sessionForm.kind === 'memorisation' ? 'active' : ''} onClick={() => setSessionForm({ ...sessionForm, kind: 'memorisation' })}><ArrowUpRight size={15} /> Memorisation</button><button type="button" className={sessionForm.kind === 'revision' ? 'active' : ''} onClick={() => setSessionForm({ ...sessionForm, kind: 'revision' })}><RotateCcw size={15} /> Revision</button></div><div className="form-columns"><div><label htmlFor="session-minutes">Time spent</label><div className="input-with-unit"><input id="session-minutes" type="number" required min={1} max={480} value={sessionForm.minutes} onChange={(event) => setSessionForm({ ...sessionForm, minutes: event.target.value })} /><span>minutes</span></div></div><div><label htmlFor="session-verses">Verses</label><div className="input-with-unit"><input id="session-verses" type="number" required min={1} max={1000} value={sessionForm.verses} onChange={(event) => setSessionForm({ ...sessionForm, verses: event.target.value })} /><span>covered</span></div></div></div><label htmlFor="session-date">Study date</label><input id="session-date" type="date" required max={today} value={sessionForm.studied_on} onChange={(event) => setSessionForm({ ...sessionForm, studied_on: event.target.value })} /><button className="button button-primary modal-submit" type="submit" disabled={saving}><Check size={17} /> Save session</button></form></Modal>}
      {notice && <div className="toast" role="status"><span className="toast-check"><Check size={14} /></span>{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    </div>
  );
}

export default App;