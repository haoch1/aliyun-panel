import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Radix owns dismissal, nested focus scopes and scroll locking. */
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
  const content = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const openerLabel = useRef(opener.current?.getAttribute("aria-label"));
  function focusContent() {
    const first = content.current?.querySelector<HTMLElement>(
      'input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),[role="combobox"]:not(:disabled)',
    );
    // Do not open a touch keyboard before the user chooses an input.
    if (matchMedia("(pointer: fine)").matches && first?.getClientRects().length)
      first.focus({ preventScroll: true });
    else content.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!viewKey) return;
    body.current?.scrollTo(0, 0);
    focusContent();
  }, [viewKey]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={"modal-backdrop " + backdropClassName}>
          <Dialog.Content
            ref={content}
            className={"modal " + (wide ? "wide " : "") + className}
            {...(!description ? { "aria-describedby": undefined } : {})}
            aria-busy={busy}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusContent();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (opener.current?.isConnected)
                opener.current.focus({ preventScroll: true });
              else if (openerLabel.current)
                document
                  .querySelector<HTMLElement>(
                    '[aria-label="' + CSS.escape(openerLabel.current) + '"]',
                  )
                  ?.focus({ preventScroll: true });
            }}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            <div key={viewKey} className="modal-view">
              <div className="modal-head">
                <div>
                  <Dialog.Title asChild>
                    <h2>{title}</h2>
                  </Dialog.Title>
                  {description && (
                    <Dialog.Description asChild>
                      <p>{description}</p>
                    </Dialog.Description>
                  )}
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭弹窗"
                    disabled={busy}
                  >
                    <X size={18} />
                  </button>
                </Dialog.Close>
              </div>
              <div ref={body} className="modal-body">
                {children}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
