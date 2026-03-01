// src/components/CollapsibleSection.jsx
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getPreference, setPreference } from '../lib/store';

export default function CollapsibleSection({ id, title, icon: Icon, badge, defaultOpen = true, children }) {
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
    <div>
      <button
        onClick={toggle}
        className="flex items-center gap-2 w-full py-1.5 text-left group"
      >
        {open
          ? <ChevronDown size={12} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />
          : <ChevronRight size={12} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />}
        {Icon && <Icon size={12} className="text-[var(--color-accent)] opacity-60" />}
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider group-hover:text-[var(--color-text-secondary)] transition-colors">
          {title}
        </span>
        {badge}
      </button>
      {open && children}
    </div>
  );
}
