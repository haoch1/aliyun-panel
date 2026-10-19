import { useId, type ReactNode } from "react";

export function Card({
  title,
  action,
  children,
  footer,
  className = "",
  id,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  id?: string;
}) {
  const titleId = useId();
  return (
    <section id={id} className={`card ${className}`} aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId}>{title}</h2>
        {action}
      </div>
      <div className="card-content">{children}</div>
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}
