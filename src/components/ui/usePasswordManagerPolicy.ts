import { useLayoutEffect } from "react";

/** 1Password's page-wide policy also covers portals and dynamically added inputs. */
export function usePasswordManagerPolicy(allowCredentials: boolean) {
  useLayoutEffect(() => {
    const body = document.body;
    if (allowCredentials) body.removeAttribute("data-1p-ignore");
    else body.setAttribute("data-1p-ignore", "true");
    return () => body.removeAttribute("data-1p-ignore");
  }, [allowCredentials]);
}
