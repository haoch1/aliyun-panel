import type { ComponentProps } from "react";
import { ignoreAutofill } from "../../lib/input-autofill";

/** Credential autofill is an explicit exception reserved for the login screen. */
export function Input({
  type = "text",
  allowPasswordManager = false,
  ...props
}: ComponentProps<"input"> & { allowPasswordManager?: boolean }) {
  return (
    <input
      {...props}
      type={type}
      {...(allowPasswordManager ? {} : ignoreAutofill)}
    />
  );
}
