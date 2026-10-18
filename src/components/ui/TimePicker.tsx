import { ChevronDown, Clock3 } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  const [position, setPosition] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useId();
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom <= 0 || rect.top >= innerHeight) return setOpen(false);
      const below = Math.max(0, innerHeight - rect.bottom - 12);
      const above = Math.max(0, rect.top - 12);
      const upward = below < 220 && above > below;
      const width = Math.min(280, document.documentElement.clientWidth - 24);
      setPosition({
        position: "fixed",
        left: Math.max(
          12,
          Math.min(
            rect.left,
            document.documentElement.clientWidth - width - 12,
          ),
        ),
        top: upward ? undefined : rect.bottom + 6,
        bottom: upward ? innerHeight - rect.top + 6 : undefined,
        width,
        maxHeight: Math.max(0, upward ? above : below),
        zIndex: 110,
      });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open]);
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
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
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
          setOpen(!open);
        }}
      >
        <Clock3 size={18} />
        <span>{value}</span>
        <ChevronDown size={14} className="select-arrow" />
      </button>
      {open && !disabled && (
        <div
          id={popup}
          className="time-popover"
          style={position}
          role="group"
          aria-label="选择时间"
        >
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
