import type { ComponentProps } from "react";

/** Ordinary fields are application data; only password fields offer vault filling. */
export function Input({ type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      type={type}
      {...(type === "password"
        ? {}
        : {
            autoComplete: "off",
            "data-1p-ignore": "true",
            "data-lpignore": "true",
            "data-bwignore": "true",
            "data-form-type": "other",
          })}
    />
  );
}
