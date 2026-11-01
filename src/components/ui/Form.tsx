import type { ComponentProps } from "react";
import { ignoreAutofill } from "../../lib/input-autofill";

/** All application forms opt out of password managers except the login form. */
export function Form({
  allowPasswordManager = false,
  ...props
}: ComponentProps<"form"> & { allowPasswordManager?: boolean }) {
  return <form {...props} {...(allowPasswordManager ? {} : ignoreAutofill)} />;
}
