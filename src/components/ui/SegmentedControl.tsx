import * as ToggleGroup from "@radix-ui/react-toggle-group";

export function SegmentedControl({
  value,
  onChange,
  label,
  options,
  disabled,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      disabled={disabled}
      aria-label={label}
      className={`segmented-control ${className}`}
      loop
    >
      {options.map(([id, text]) => (
        <ToggleGroup.Item key={id} value={id}>
          {text}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
