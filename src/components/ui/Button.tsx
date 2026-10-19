import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "outline",
  size = "default",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "primary" | "ghost" | "danger";
  size?: "default" | "small" | "icon";
}) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={`button ${variant === "outline" ? "" : variant} ${size === "small" ? "small" : size === "icon" ? "icon-button" : ""} ${className}`.trim()}
      {...props}
    />
  );
}
