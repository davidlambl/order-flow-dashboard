// src/components/CollapsibleSection.jsx
// A section of the dashboard that collapses to its header, in the accordion pattern: the title is a level-2 heading
// holding the toggle, so a screen reader's heading list has the section and its toggle in one place, and a chart's h3
// inside follows an h2. While open, the toggle's aria-controls names the content, a region labelled by the title
// alone: the toggle's own name also carries the badge (Research's "Loading..."), which is no part of a landmark's
// name. Collapsed, the content is not rendered (the charts are fetched only while their section is open), so the
// toggle names nothing. The content is padded unless noPadding, which puts the children straight in the region.
import { useId } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { usePreference } from '../hooks/useStoreValue.js';

export default function CollapsibleSection({ id, title, icon: Icon, badge, defaultOpen = true, noPadding = false, children }) {
  const [saved, save] = usePreference(`section_${id}`);
  const open = saved ?? defaultOpen;
  const titleId = useId();
  const contentId = useId();

  // The store is the source of truth: the click handler writes it (once per click, never a render: D12) and
  // usePreference re-renders every reader of the name, this one included.
  const toggle = () => save(!open);

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] fade-in">
      <h2>
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          className="flex items-center gap-2 w-full px-4 py-3 text-left group"
        >
          {open
            ? <ChevronDown size={14} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />
            : <ChevronRight size={14} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors" />}
          {Icon && <Icon size={14} className="text-[var(--color-accent)]" />}
          <span id={titleId} className="text-sm font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-text-secondary)] transition-colors">
            {title}
          </span>
          {badge}
        </button>
      </h2>
      {open && (
        <div id={contentId} role="region" aria-labelledby={titleId} className={noPadding ? undefined : 'px-4 pb-4'}>
          {children}
        </div>
      )}
    </div>
  );
}
