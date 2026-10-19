import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export const TooltipProvider = Primitive.Provider;

export function Tooltip({
  content,
  children,
}: {
  content?: ReactNode;
  children: ReactElement;
}) {
  if (!content) return children;
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="tooltip"
          sideOffset={7}
          collisionPadding={12}
        >
          {content}
          <Primitive.Arrow className="tooltip-arrow" />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
