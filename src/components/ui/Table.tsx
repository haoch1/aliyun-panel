import type { ComponentProps } from "react";

export function Table({ className = "", ...props }: ComponentProps<"table">) {
  return (
    <table data-slot="table" className={`data-table ${className}`} {...props} />
  );
}

export function TablePanel({
  className = "",
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="table-panel"
      className={`table-panel ${className}`}
      {...props}
    />
  );
}
