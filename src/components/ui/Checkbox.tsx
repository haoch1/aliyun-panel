import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { Input } from "./Input";

export function Checkbox({
  indeterminate = false,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <Input ref={ref} type="checkbox" {...props} />;
}
