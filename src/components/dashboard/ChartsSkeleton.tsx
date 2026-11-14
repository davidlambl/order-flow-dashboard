// src/components/dashboard/ChartsSkeleton.tsx
// The Charts section while ChartsPanel's module loads: the panel's grid with two cards drawn exactly as GexChart and
// FlowChart draw themselves while the market data loads, so nothing moves when the charts arrive. It imports no chart
// code, so it stays in the entry chunk; App.lazy.test.jsx keeps both cards the same as the charts' own.

/**
 * A chart's card while it has nothing to draw yet: the 340 px card with a bar for the title and one for the plot, a
 * status whose visually hidden text tells a screen reader that the chart is on its way.
 */
function SkeletonCard() {
  return (
    <div role="status" className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 h-[340px]">
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-4 w-40 mb-4" />
      <div className="skeleton h-[280px] w-full" />
    </div>
  );
}

export default function ChartsSkeleton() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
