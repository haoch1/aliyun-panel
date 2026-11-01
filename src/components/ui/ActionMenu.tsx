import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";

// Preserve business buttons and handlers; Radix supplies the menu behavior.
function menuItems(children: ReactNode, beforeSelect: () => void): ReactNode {
  return Children.map(children, (child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        disabled?: boolean;
        onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
      }>(child)
    )
      return child;
    if (child.type === "button")
      return (
        <Menu.Item asChild disabled={child.props.disabled}>
          {cloneElement(child, {
            onClick: (event: MouseEvent<HTMLButtonElement>) => {
              beforeSelect();
              child.props.onClick?.(event);
            },
          })}
        </Menu.Item>
      );
    if (child.type === "hr")
      return <Menu.Separator asChild>{child}</Menu.Separator>;
    if (child.props.children)
      return cloneElement(
        child,
        {},
        menuItems(child.props.children, beforeSelect),
      );
    return child;
  });
}
export function ActionMenu({
  label,
  children,
  open,
  onOpenChange,
}: {
  label: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="button small instance-menu-button"
          aria-label={label + " 操作"}
        >
          操作
          <ChevronDown size={14} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="context-menu instance-menu"
          aria-label={label + " 操作菜单"}
          align="end"
          sideOffset={5}
          collisionPadding={8}
          loop
          onCloseAutoFocus={(event) => {
            if (document.querySelector('[role="dialog"]'))
              event.preventDefault();
          }}
        >
          <Menu.Label className="menu-title">{label}</Menu.Label>
          <Menu.Group>
            {menuItems(children, () =>
              trigger.current?.focus({ preventScroll: true }),
            )}
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
