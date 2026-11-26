import type { ReactNode } from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={"skeleton " + className} aria-hidden="true" />;
}

export function LoadingRegion({
  children,
  label = "正在读取数据",
  className = "",
  inline = false,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  inline?: boolean;
}) {
  const Element = inline ? "span" : "div";
  return (
    <Element
      role="status"
      aria-label={label}
      className={"skeleton-region " + className}
    >
      {children}
    </Element>
  );
}

export function InventorySkeleton() {
  return (
    <div className="inventory-card-skeleton" aria-hidden="true">
      <div className="inventory-card-skeleton-head">
        <Skeleton className="skeleton-title" />
        <Skeleton className="skeleton-badge" />
      </div>
      <Skeleton className="skeleton-meta" />
      <Skeleton className="skeleton-track" />
      <div className="inventory-card-skeleton-fields">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
      <Skeleton className="skeleton-button" />
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="chart-placeholder" aria-hidden="true">
      {Array.from({ length: 15 }, (_, i) => (
        <Skeleton key={i} />
      ))}
    </div>
  );
}
