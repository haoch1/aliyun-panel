import { ChevronDown, Clock3 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import Select from "./Select";

export default function TimePicker({
  value,
  onChange,
  disabled = false,
  id,
  "aria-describedby": description,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useId();
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const element = event.target as Element;
      if (!root.current?.contains(element) && !element.closest(".select-menu"))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={root}
      className="time-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        className="select-trigger time-trigger"
        aria-describedby={description}
        aria-expanded={open}
        aria-controls={open ? popup : undefined}
        disabled={disabled}
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAbove(!!rect && innerHeight - rect.bottom < 210 && rect.top > 210);
          setOpen(!open);
        }}
      >
        <Clock3 size={18} />
        <span>{value}</span>
        <ChevronDown size={14} className="select-arrow" />
      </button>
      {open && !disabled && (
        <div id={popup} className={"time-popover" + (above ? " above" : "")}>
          <div className="time-picker-parts">
            <label>
              <span>小时</span>
              <Select
                aria-label="小时"
                value={value.slice(0, 2)}
                onChange={(e) => onChange(e.target.value + value.slice(2))}
              >
                {Array.from({ length: 24 }, (_, hour) => {
                  const time = String(hour).padStart(2, "0");
                  return (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  );
                })}
              </Select>
            </label>
            <label>
              <span>分钟</span>
              <Select
                aria-label="分钟"
                value={value.slice(3)}
                onChange={(e) => onChange(value.slice(0, 3) + e.target.value)}
              >
                {Array.from({ length: 60 }, (_, minute) => {
                  const time = String(minute).padStart(2, "0");
                  return (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  );
                })}
              </Select>
            </label>
          </div>
          <button
            type="button"
            className="button small"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            确定
          </button>
        </div>
      )}
    </div>
  );
}
