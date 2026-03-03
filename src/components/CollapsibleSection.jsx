// src/components/CollapsibleSection.jsx
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getPreference, setPreference } from '../lib/store';

export default function CollapsibleSection({ id, title, icon: Icon, badge, defaultOpen = true, noPadding = false, children }) {
  const [open, setOpen] = useState(() => {
    const saved = getPreference(`section_${id}`);
    return saved != null ? saved : defaultOpen;
  });

  useEffect(() => {
    const handler = () => {
      const saved = getPreference(`section_${id}`);
      if (saved != null) setOpen(saved);
    };
    window.addEventListener('store-changed', handler);
    return () => window.removeEventListener('store-changed', handler);
  }, [id]);

  const toggle = () => setOpen((v) => {
    const next = !v;
    setPreference(`section_${id}`, next);
    return next;
  });

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] fade-in">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-2 w-full px-4 py-3 text-left group"
      >
        {open
          ? <ChevronDown size={14} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />
          : <ChevronRight size={14} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />}
        {Icon && <Icon size={14} className="text-[var(--color-accent)]" />}
        <span className="text-sm font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-text-secondary)] transition-colors">
          {title}
        </span>
        {badge}
      </button>
      {open && (noPadding ? children : <div className="px-4 pb-4">{children}</div>)}
    </div>
  );
}
