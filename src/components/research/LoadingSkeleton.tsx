// src/components/research/LoadingSkeleton.tsx
// Placeholder rows in place of a research panel's content while a refetch runs over the context already shown: a
// status whose visually hidden text tells a screen reader what the shimmering rows show a sighted user.

interface LoadingSkeletonProps {
  rows?: number;
}

export default function LoadingSkeleton({ rows = 3 }: LoadingSkeletonProps) {
  return (
    <div role="status" className="space-y-2">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-4 w-full rounded" />
      ))}
    </div>
  );
}
