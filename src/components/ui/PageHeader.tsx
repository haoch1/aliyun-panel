import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  icon: LucideIcon;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>
          <Icon aria-hidden="true" />
          {title}
        </h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
