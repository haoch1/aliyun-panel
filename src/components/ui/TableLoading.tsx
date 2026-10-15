/** Quiet placeholders stay inside the same columns as the eventual result. */
export function TableLoading({
  columns,
  lines = 1,
}: {
  columns: string[];
  lines?: number | number[];
}) {
  return (
    <tr className="table-loading-row">
      {columns.map((label, index) => (
        <td
          key={index}
          data-label={label || undefined}
          className={label ? undefined : "check-cell"}
        >
          {index === 0 && (
            <span className="sr-only" role="status">
              正在读取数据…
            </span>
          )}
          {Array.from(
            {
              length: label ? (Array.isArray(lines) ? lines[index] : lines) : 1,
            },
            (_, row) => (
              <span
                className="table-placeholder"
                aria-hidden="true"
                key={row}
              />
            ),
          )}
        </td>
      ))}
    </tr>
  );
}
