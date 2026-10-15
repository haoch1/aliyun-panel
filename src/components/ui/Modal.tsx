import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
const modalStack: symbol[] = [];
let originalOverflow = "";
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  busy = false,
  className = "",
  backdropClassName = "",
  viewKey,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
  className?: string;
  backdropClassName?: string;
  viewKey?: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const identity = Symbol("modal");
    if (!modalStack.length) originalOverflow = document.body.style.overflow;
    modalStack.push(identity);
    const old = document.activeElement as HTMLElement;
    const focusables = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        ) || [],
      ).filter(
        (x) =>
          !x.hasAttribute("disabled") &&
          x.tabIndex >= 0 &&
          x.getClientRects().length,
      );
    const controls = focusables();
    (
      controls.find(
        (x) =>
          ["INPUT", "SELECT", "TEXTAREA"].includes(x.tagName) ||
          x.getAttribute("role") === "combobox",
      ) || controls[0]
    )?.focus({ preventScroll: true });
    const listener = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== identity) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (e.key === "Tab") {
        const a = focusables(),
          first = a[0],
          last = a[a.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus({ preventScroll: true });
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first?.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener("keydown", listener);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", listener);
      modalStack.splice(modalStack.indexOf(identity), 1);
      if (!modalStack.length) document.body.style.overflow = originalOverflow;
      if (old?.isConnected) old.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!viewKey) return;
    bodyRef.current?.scrollTo(0, 0);
    const controls = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        "button,input,select,textarea,a[href]",
      ) || [],
    ).filter(
      (control) =>
        !control.hasAttribute("disabled") && control.getClientRects().length,
    );
    (
      controls.find((control) =>
        ["INPUT", "SELECT", "TEXTAREA"].includes(control.tagName),
      ) || controls[0]
    )?.focus({ preventScroll: true });
  }, [viewKey]);
  return createPortal(
    <div
      className={"modal-backdrop " + backdropClassName}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        className={"modal " + (wide ? "wide " : "") + className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? titleId + "-description" : undefined}
        aria-busy={busy}
      >
        <div key={viewKey} className="modal-view">
          <div className="modal-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && (
                <p id={titleId + "-description"}>{description}</p>
              )}
            </div>
            <button
              className="icon-button"
              aria-label="关闭弹窗"
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
          <div ref={bodyRef} className="modal-body">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
