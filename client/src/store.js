// Tiny global store for the PII ↔ Pseudonym view toggle.
// Persisted to localStorage. Default = pseudonym (handoff §6).
import { useEffect, useState } from 'react';

const KEY = 'fg-state';
const DEFAULTS = { view: 'pseudonym' }; // 'pseudonym' | 'pii'

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = read();
const subs = new Set();

function notify() { for (const fn of subs) fn(state); }

export function getState() { return state; }
export function setView(v) {
  if (v !== 'pseudonym' && v !== 'pii') return;
  state = { ...state, view: v };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  notify();
}

// React hook
export function useFG() {
  const [s, setS] = useState(state);
  useEffect(() => {
    const fn = (next) => setS(next);
    subs.add(fn);
    return () => { subs.delete(fn); };
  }, []);
  return s;
}

export function isPseudonym() { return state.view === 'pseudonym'; }
