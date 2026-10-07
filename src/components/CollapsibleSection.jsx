// src/components/CollapsibleSection.jsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import { usePreference } from '../hooks/useStoreValue.js';

export default function CollapsibleSection({ id, title, icon: Icon, badge, defaultOpen = true, noPadding = false, children }) {
  const [saved, save] = usePreference(`section_${id}`);
  const open = saved ?? defaultOpen;

  // The store is the source of truth: the click handler writes it (once per click, never a render: D12) and
  // usePreference re-renders every reader of the name, this one included.
  const toggle = () => save(!open);

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
