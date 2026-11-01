import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

const query = "(max-width: 900px)";
const subscribe = (callback: () => void) => {
  const media = matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};
export function Sidebar({
  open,
  onOpenChange,
  id,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
  children: ReactNode;
}) {
  const mobile = useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
  useEffect(() => {
    if (!mobile && open) onOpenChange(false);
  }, [mobile, open, onOpenChange]);
  if (!mobile)
    return (
      <aside id={id} className="sidebar" aria-label="主导航">
        {children}
      </aside>
    );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="navigation-backdrop" />
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLElement>("#" + id + ' [aria-current="page"]')
              ?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLElement>(".mobile-menu")
              ?.focus({ preventScroll: true });
          }}
        >
          <aside id={id} className="sidebar mobile-open open">
            <Dialog.Title className="sr-only">主导航</Dialog.Title>
            {children}
          </aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
