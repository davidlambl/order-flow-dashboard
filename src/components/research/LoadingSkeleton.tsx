// src/components/research/LoadingSkeleton.tsx
// Placeholder rows in place of a research panel's content while a refetch runs over the context already shown.

interface LoadingSkeletonProps {
  rows?: number;
}

export default function LoadingSkeleton({ rows = 3 }: LoadingSkeletonProps) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-4 w-full rounded" />
      ))}
    </div>
  );
}
