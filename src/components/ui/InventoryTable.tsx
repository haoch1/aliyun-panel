import {
  Children,
  isValidElement,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type MouseEventHandler,
} from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "./ShadcnCard";

const query = "(max-width: 900px)";
const subscribe = (notify: () => void) => {
  const media = matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
type Cell = ReactElement<{ children?: ReactNode; "data-label"?: string }>;
type Row = ReactElement<{
  children?: ReactNode;
  className?: string;
  "data-selected"?: boolean;
  onContextMenu?: MouseEventHandler<HTMLTableRowElement>;
}>;

/** Keep one set of data, selections and actions for the desktop table and mobile Card view. */
export function InventoryTable({
  children,
  ...props
}: ComponentProps<"table">) {
  const mobile = useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
  if (!mobile) return <table {...props}>{children}</table>;
  const body = Children.toArray(children).find(
    (node) => isValidElement(node) && node.type === "tbody",
  ) as ReactElement<{ children?: ReactNode }> | undefined;
  const rows = Children.toArray(body?.props.children);
  return (
    <div
      className="inventory-cards"
      role="list"
      aria-label={props["aria-label"]}
    >
      {rows.map((node, index) => {
        if (!isValidElement(node) || node.type !== "tr")
          return (
            <Card key={index} size="sm">
              <CardContent>
                <div
                  className="inventory-card-placeholder"
                  aria-label="正在加载实例"
                  aria-busy="true"
                />
              </CardContent>
            </Card>
          );
        const row = node as Row;
        const cells = Children.toArray(row.props.children).filter(
          (cell) => isValidElement(cell) && cell.type === "td",
        ) as Cell[];
        const cell = (label: string) =>
          cells.find((cell) => cell.props["data-label"] === label);
        const title = Children.toArray(cell("实例")?.props.children);
        const selected =
          row.props["data-selected"] ||
          row.props.className?.split(" ").includes("selected");
        const fields = cells.filter(
          (item) =>
            item.props["data-label"] &&
            !["实例", "状态", "本月流量", "操作"].includes(
              item.props["data-label"]!,
            ),
        );
        // Network identifiers get their own line; compact metadata follows in two columns.
        const order = [
          "公网 IP",
          "网络",
          "规格 / 价格",
          "账户 / 区域",
          "保活",
          "本月费用",
          "流量保护",
          "定时关机",
        ];
        fields.sort(
          (a, b) =>
            order.indexOf(a.props["data-label"]!) -
            order.indexOf(b.props["data-label"]!),
        );
        return (
          <Card
            key={row.key || index}
            size="sm"
            role="listitem"
            data-selected={selected || undefined}
            onContextMenu={
              row.props
                .onContextMenu as unknown as MouseEventHandler<HTMLDivElement>
            }
          >
            <CardHeader>
              <CardTitle>{title[0]}</CardTitle>
              {title.length > 1 && (
                <CardDescription>{title.slice(1)}</CardDescription>
              )}
              <CardAction>
                <div className="inventory-card-actions">
                  {cell("状态")?.props.children}
                  {cells[0]?.props.children}
                </div>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="inventory-card-traffic">
                {cell("本月流量")?.props.children}
              </div>
              <dl className="inventory-card-fields">
                {fields.map((item) => (
                  <div
                    key={item.props["data-label"]}
                    data-field={item.props["data-label"]}
                  >
                    <dt>{item.props["data-label"]}</dt>
                    <dd>{item.props.children}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
            <CardFooter className="justify-end">
              {cell("操作")?.props.children}
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
