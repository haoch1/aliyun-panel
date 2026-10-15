import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";

/** Busy feedback must not replace the caption, move the button, or drop focus. */
export function PendingButton({
  busy,
  pendingLabel,
  children,
  className = "button primary",
  disabled,
  onClick,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  busy: boolean;
  pendingLabel: string;
  children: ReactNode;
}) {
  const statusId = useId();
  return (
    <>
      <button
        {...props}
        className={className + " pending-button"}
        disabled={disabled}
        aria-disabled={busy || disabled || undefined}
        aria-busy={busy}
        aria-describedby={
          [props["aria-describedby"], busy ? statusId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={(event) => {
          if (busy || disabled) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onClick?.(event);
        }}
      >
        <span className="pending-button-label">{children}</span>
      </button>
      <span id={statusId} className="sr-only" role="status">
        {busy ? pendingLabel : ""}
      </span>
    </>
  );
}
