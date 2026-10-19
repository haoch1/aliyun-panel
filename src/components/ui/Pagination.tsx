import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export function Pagination({
  page,
  pages,
  onChange,
  children,
  total,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  children?: ReactNode;
  total?: number;
}) {
  const visible = [...new Set([0, page - 1, page, page + 1, pages - 1])]
    .filter((n) => n >= 0 && n < pages)
    .sort((a, b) => a - b);
  return (
    <nav className="pagination" aria-label="分页">
      <div className="pagination-info">
        {children}
        {total !== undefined && (
          <span>共 {total.toLocaleString("zh-CN")} 条</span>
        )}
      </div>
      <div className="pagination-controls">
        <Button
          size="icon"
          aria-label="上一页"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span className="pagination-mobile">
          {page + 1} / {pages}
        </span>
        <div className="pagination-pages">
          {visible.map((n, index) => (
            <span className="pagination-page" key={n}>
              {index > 0 && n - visible[index - 1] > 1 && (
                <span className="pagination-ellipsis">…</span>
              )}
              <Button
                size="icon"
                variant={n === page ? "primary" : "ghost"}
                aria-label={`第 ${n + 1} 页`}
                aria-current={n === page ? "page" : undefined}
                onClick={() => onChange(n)}
              >
                {n + 1}
              </Button>
            </span>
          ))}
        </div>
        <Button
          size="icon"
          aria-label="下一页"
          disabled={page >= pages - 1}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
