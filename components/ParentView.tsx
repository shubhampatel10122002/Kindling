'use client';

import { useEffect, useState } from 'react';
import type { ChildMemory, ChildNote } from '@/lib/types';

/**
 * The grown-up view. Read-only, and deliberately not a report card.
 *
 * It answers the questions a parent actually has — is she getting better, what
 * keeps tripping her up, what does she care about, what has she been telling
 * this thing — and it shows her own words where it can, because that is the part
 * a parent will read twice.
 */

interface Payload {
  child: { id: string; name: string; age: number | null; onboarding_notes: string | null } | null;
  memory: ChildMemory;
  snapshot: { sessions: number; wordsRead: number; accuracyAllTime: number; accuracyRecent: number };
  improved: string[];
  sticky: { word: string; misses: number; attempts: number }[];
  notes: ChildNote[];
  flags: { type: string; detail: string; ts: string }[];
  skills: { skill_id: string; p_mastery: number; description: string }[];
  sessions: { id: string; started_at: string; ended_at: string | null; passages: number; said: string[] }[];
}

const NOTE_LABEL: Record<string, string> = {
  event: 'happened',
  interest: 'loves',
  question: 'wondered',
  person: 'someone',
  mood: 'felt',
};

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function when(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

export default function ParentView() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [resetDone, setResetDone] = useState(false);
  const [resetError, setResetError] = useState('');

  useEffect(() => {
    fetch('/api/parent')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  async function doReset() {
    setResetError('');
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResetError(body.error ?? 'Reset failed.');
        return;
      }
      setResetDone(true);
    } catch (e) {
      setResetError(String(e));
    }
  }

  if (error) return <main className="parent"><p className="muted">{error}</p></main>;
  if (!data) return <main className="parent"><p className="muted">Loading…</p></main>;

  if (resetDone) {
    return (
      <main className="parent">
        <h1>All forgotten</h1>
        <p className="muted">
          Ollie has no memory of anyone now. The next time the app is opened he will introduce
          himself and ask for a name, the same as the very first time.
        </p>
        <p style={{ marginTop: 20 }}>
          <a className="btn btn-primary" href="/">
            Start over
          </a>
        </p>
      </main>
    );
  }

  if (!data.child) {
    return (
      <main className="parent">
        <h1>Nothing here yet</h1>
        <p className="muted">Once a child has read with Ollie, their journey shows up here.</p>
      </main>
    );
  }

  const { child, memory, snapshot, improved, sticky, notes, flags, skills, sessions } = data;
  const trend = snapshot.accuracyRecent - snapshot.accuracyAllTime;
  const questions = notes.filter((n) => n.kind === 'question');
  const life = notes.filter((n) => n.kind !== 'question' && n.kind !== 'mood');

  return (
    <main className="parent">
      <header className="parent-head">
        <h1>{child.name}</h1>
        <p className="muted">
          {snapshot.sessions} session{snapshot.sessions === 1 ? '' : 's'} · {snapshot.wordsRead} words
          read aloud
        </p>
      </header>

      <section className="parent-tiles">
        <div className="tile">
          <div className="tile-value">{pct(snapshot.accuracyRecent)}</div>
          <div className="tile-label">read correctly, recently</div>
          {snapshot.sessions > 1 && (
            <div className={`tile-trend ${trend >= 0 ? 'up' : 'down'}`}>
              {trend >= 0 ? '▲' : '▼'} {pct(Math.abs(trend))} vs. all time
            </div>
          )}
        </div>
        <div className="tile">
          <div className="tile-value">{improved.length}</div>
          <div className="tile-label">words that used to be hard</div>
        </div>
        <div className="tile">
          <div className="tile-value">{questions.length}</div>
          <div className="tile-label">questions in the jar</div>
        </div>
      </section>

      {improved.length > 0 && (
        <section className="parent-card">
          <h2>She can read these now</h2>
          <p className="muted">She missed each of these before, and reads them first try now.</p>
          <div className="chips">
            {improved.map((w) => (
              <span key={w} className="chip good">{w}</span>
            ))}
          </div>
        </section>
      )}

      {sticky.length > 0 && (
        <section className="parent-card">
          <h2>Still tricky</h2>
          <p className="muted">Worth reading together outside the app.</p>
          <div className="chips">
            {sticky.map((s) => (
              <span key={s.word} className="chip warn" title={`missed ${s.misses} of ${s.attempts}`}>
                {s.word}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="parent-card">
        <h2>What she has been telling Ollie</h2>
        {life.length === 0 && questions.length === 0 ? (
          <p className="muted">Nothing yet. It fills up fast once she starts talking.</p>
        ) : (
          <ul className="notes">
            {notes.slice(0, 20).map((n) => (
              <li key={n.id}>
                <span className={`note-kind k-${n.kind}`}>{NOTE_LABEL[n.kind] ?? n.kind}</span>
                <span className="note-subject">{n.subject}</span>
                {n.status === 'used' && <span className="note-used">became a story</span>}
                {n.status === 'cameo' && <span className="note-used">appeared in a story</span>}
                {n.ts && <span className="note-when">{when(n.ts)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {questions.length > 0 && (
        <section className="parent-card">
          <h2>The question jar</h2>
          <p className="muted">
            Ollie never answers these on the spot. Each one becomes a story she reads later.
          </p>
          <ul className="notes">
            {questions.slice(0, 8).map((q) => (
              <li key={q.id}>
                <span className="note-subject">{q.subject}</span>
                <span className="note-used">{q.status === 'used' ? 'answered by a story' : 'waiting'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="parent-card">
        <h2>What Ollie has worked out about her</h2>
        {memory.personality_notes ? (
          <p className="personality">{memory.personality_notes}</p>
        ) : (
          <p className="muted">Not enough sessions yet.</p>
        )}
        {memory.interests?.length > 0 && (
          <div className="chips" style={{ marginTop: 12 }}>
            {memory.interests
              .slice()
              .sort((a, b) => b.weight - a.weight)
              .slice(0, 10)
              .map((i) => (
                <span
                  key={i.topic}
                  className="chip"
                  style={{ opacity: Math.max(0.45, Math.min(1, i.weight / 2)) }}
                >
                  {i.topic}
                </span>
              ))}
          </div>
        )}
        {(memory.canon?.characters?.length ?? 0) > 0 && (
          <p className="muted" style={{ marginTop: 12 }}>
            Characters she knows: {memory.canon!.characters!.join(', ')}
          </p>
        )}
      </section>

      <section className="parent-card">
        <h2>Reading skills</h2>
        <div className="skill-grid">
          {skills.slice(0, 12).map((s) => (
            <div key={s.skill_id} className="bar-row">
              <span title={s.skill_id}>{s.description}</span>
              <span className="bar">
                <span className="bar-fill" style={{ width: `${Math.round(s.p_mastery * 100)}%` }} />
              </span>
              <span>{pct(s.p_mastery)}</span>
            </div>
          ))}
        </div>
      </section>

      {flags.length > 0 && (
        <section className="parent-card">
          <h2>Worth knowing</h2>
          <ul className="notes">
            {flags.map((f, i) => (
              <li key={i}>
                <span className={`note-kind k-${f.type === 'sensitive_topic' ? 'mood' : 'event'}`}>
                  {f.type.replace('_', ' ')}
                </span>
                <span className="note-subject">{f.detail}</span>
                <span className="note-when">{when(f.ts)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="parent-card">
        <h2>Recent sessions</h2>
        <ul className="notes">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="note-when">{when(s.started_at)}</span>
              <span className="note-subject">
                {s.passages} passage{s.passages === 1 ? '' : 's'}
                {s.said.length > 0 && ` · “${s.said[0]}”`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="parent-card danger">
        <h2>Start over</h2>
        <p className="muted">
          Erases everything Ollie knows about {child.name} — her reading history, the words she
          has learned, what she has told him, and every story so far. He will introduce himself
          and ask for a name again, as if they had never met. This cannot be undone.
        </p>

        {!resetting ? (
          <button className="btn btn-danger" style={{ marginTop: 14 }} onClick={() => setResetting(true)}>
            Reset {child.name}&rsquo;s profile
          </button>
        ) : (
          <form
            className="name-card"
            onSubmit={(e) => {
              e.preventDefault();
              void doReset();
            }}
          >
            <input
              autoFocus
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={`Type “${child.name}” to confirm`}
              aria-label="Confirm the child's name"
            />
            <button
              className="btn btn-danger"
              type="submit"
              disabled={confirmName.trim().toLowerCase() !== child.name.trim().toLowerCase()}
            >
              Erase everything
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setResetting(false);
                setConfirmName('');
                setResetError('');
              }}
            >
              Cancel
            </button>
          </form>
        )}

        {resetError && (
          <p className="muted" style={{ marginTop: 10, color: 'var(--bad)' }}>
            {resetError}
          </p>
        )}
      </section>
    </main>
  );
}
