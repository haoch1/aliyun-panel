import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <div className="time-picker">
        <Popover.Trigger asChild>
          <button
            id={id}
            type="button"
            className="select-trigger time-trigger"
            aria-describedby={description}
            disabled={disabled}
          >
            <Clock3 size={16} />
            <span>{value}</span>
            <ChevronDown size={14} className="select-arrow" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="time-popover"
            aria-label="选择时间"
            sideOffset={6}
            collisionPadding={12}
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
            <Popover.Close asChild>
              <button type="button" className="button small">
                确定
              </button>
            </Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
