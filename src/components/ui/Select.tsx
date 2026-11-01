import * as Primitive from "@radix-ui/react-select";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Input } from "./Input";

type Option = {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
  group?: string;
};
type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  pending?: boolean;
  icon?: ReactNode;
  placement?: "down" | "auto";
  openFromStart?: boolean;
  renderOption?: (value: string) => ReactNode;
  renderValue?: (value: string) => ReactNode;
  menuClassName?: string;
  menuMinWidth?: number;
  searchable?: boolean;
};
function plain(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  return isValidElement<{ children?: ReactNode }>(node)
    ? plain(node.props.children)
    : "";
}
function optionsOf(
  children: ReactNode,
  group?: string,
  disabled = false,
): Option[] {
  const result: Option[] = [];
  Children.forEach(children, (child) => {
    if (
      !isValidElement<{
        value?: string | number;
        children?: ReactNode;
        label?: string;
        disabled?: boolean;
      }>(child)
    )
      return;
    if (child.type === "optgroup" || child.type === Fragment)
      result.push(
        ...optionsOf(
          child.props.children,
          child.props.label || group,
          disabled || !!child.props.disabled,
        ),
      );
    else if (child.type === "option")
      result.push({
        value: String(child.props.value ?? plain(child.props.children)),
        label: child.props.children,
        text: plain(child.props.children),
        disabled: disabled || !!child.props.disabled,
        group,
      });
  });
  return result;
}
// Prefix values to support native <option value=""> without Radix's reserved empty value.
const keyOf = (value: string) => "option:" + value;
export default function Select({
  children,
  value,
  defaultValue,
  onChange,
  className = "",
  icon,
  placement = "auto",
  openFromStart = false,
  renderOption,
  renderValue,
  menuClassName = "",
  menuMinWidth = 0,
  searchable = false,
  id,
  required,
  disabled: unavailable,
  pending = false,
  name,
  ...props
}: Props) {
  const disabled = unavailable || pending;
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const [internal, setInternal] = useState(String(defaultValue ?? ""));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const options = optionsOf(children);
  const current = String(value ?? internal);
  const selected =
    options.find((option) => option.value === current) || options[0];
  const visible = options.filter((option) =>
    option.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  function change(next: string) {
    const option = options.find((option) => keyOf(option.value) === next);
    if (!option || option.disabled || disabled) return;
    setInternal(option.value);
    if (native.current) {
      native.current.value = option.value;
      onChange?.({
        target: native.current,
        currentTarget: native.current,
      } as ChangeEvent<HTMLSelectElement>);
    }
    setOpen(false);
  }
  function changeOpen(next: boolean) {
    setOpen(next && !disabled);
    if (next) {
      setQuery("");
      const initial =
        !openFromStart && selected && !selected.disabled
          ? selected
          : options.find((option) => !option.disabled);
      setActive(initial ? keyOf(initial.value) : "");
    }
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const triggerElement = (
    <button
      ref={trigger}
      id={id}
      type="button"
      className="select-trigger"
      disabled={disabled}
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      aria-required={required}
      data-pending={(pending && !unavailable) || undefined}
      title={props.title}
      onKeyDown={(event) => {
        if (
          searchable &&
          !event.nativeEvent.isComposing &&
          ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)
        ) {
          event.preventDefault();
          changeOpen(true);
        }
      }}
    >
      {icon && <span className="select-icon">{icon}</span>}
      <span className="select-value">
        {selected
          ? (renderValue?.(selected.value) ?? selected.label)
          : "请选择"}
      </span>
      <ChevronDown size={14} className="select-arrow" />
    </button>
  );
  const nativeElement = (
    <select
      ref={native}
      id={id ? id + "-native" : undefined}
      value={current}
      name={name}
      required={required}
      disabled={disabled}
      aria-hidden="true"
      tabIndex={-1}
      className="select-native"
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      onChange={onChange}
      onInvalid={(event) => {
        event.preventDefault();
        changeOpen(true);
        trigger.current?.focus();
      }}
    >
      {children}
    </select>
  );
  const contentStyle = {
    "--select-min-width": menuMinWidth + "px",
  } as React.CSSProperties;
  if (searchable)
    return (
      <div className={"custom-select " + className}>
        <Popover.Root open={open} onOpenChange={changeOpen}>
          <Popover.Trigger asChild>{triggerElement}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className={"select-menu searchable-select " + menuClassName}
              style={contentStyle}
              sideOffset={5}
              collisionPadding={8}
              avoidCollisions={placement === "auto"}
              aria-label={props["aria-label"] || "选择选项"}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                queryInput.current?.focus({ preventScroll: true });
              }}
            >
              <Command
                label={props["aria-label"] || "选择选项"}
                shouldFilter={false}
                loop
                value={active}
                onValueChange={setActive}
                onKeyDownCapture={(event) => {
                  if (event.nativeEvent.isComposing) event.stopPropagation();
                }}
              >
                <div className="select-search">
                  <Search size={15} />
                  <Command.Input asChild value={query} onValueChange={setQuery}>
                    <Input
                      ref={queryInput}
                      aria-label={"搜索" + (props["aria-label"] || "选项")}
                    />
                  </Command.Input>
                </div>
                <Command.List className="select-options">
                  <Command.Empty className="select-empty">
                    没有匹配的选项
                  </Command.Empty>
                  {Array.from(
                    new Set(visible.map((option) => option.group)),
                  ).map((group) => (
                    <Command.Group key={group || "ungrouped"} heading={group}>
                      {visible
                        .filter((option) => option.group === group)
                        .map((option) => (
                          <Command.Item
                            key={option.value}
                            value={keyOf(option.value)}
                            disabled={option.disabled}
                            onSelect={change}
                            data-current={option.value === current}
                            className={
                              "select-option " +
                              (option.disabled ? "disabled" : "")
                            }
                          >
                            <span>
                              {renderOption?.(option.value) ?? option.label}
                            </span>
                            {option.value === current && <Check size={14} />}
                          </Command.Item>
                        ))}
                    </Command.Group>
                  ))}
                </Command.List>
              </Command>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {nativeElement}
      </div>
    );
  return (
    <div className={"custom-select " + className}>
      <Primitive.Root
        value={selected ? keyOf(selected.value) : ""}
        onValueChange={change}
        disabled={disabled}
        open={open}
        onOpenChange={changeOpen}
      >
        <Primitive.Trigger asChild>{triggerElement}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            className={"select-menu " + menuClassName}
            position="popper"
            style={contentStyle}
            sideOffset={5}
            collisionPadding={8}
            avoidCollisions={placement === "auto"}
          >
            <Primitive.Viewport className="select-options">
              {Array.from(new Set(options.map((option) => option.group))).map(
                (group) => (
                  <Primitive.Group key={group || "ungrouped"}>
                    {group && (
                      <Primitive.Label className="select-group">
                        {group}
                      </Primitive.Label>
                    )}
                    {options
                      .filter((option) => option.group === group)
                      .map((option) => (
                        <Primitive.Item
                          key={option.value}
                          value={keyOf(option.value)}
                          disabled={option.disabled}
                          textValue={option.text}
                          className={
                            "select-option " +
                            (option.disabled ? "disabled" : "")
                          }
                          data-current={option.value === current}
                        >
                          <Primitive.ItemText>
                            {renderOption?.(option.value) ?? option.label}
                          </Primitive.ItemText>
                          <Primitive.ItemIndicator>
                            <Check size={14} />
                          </Primitive.ItemIndicator>
                        </Primitive.Item>
                      ))}
                  </Primitive.Group>
                ),
              )}
            </Primitive.Viewport>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
      {nativeElement}
    </div>
  );
}
