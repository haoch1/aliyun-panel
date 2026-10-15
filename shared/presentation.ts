export type DataTime = { label: string; value?: number | string | null };
export const displayTrafficUnits = (value: string) =>
  value.replace(/\b([KMGT])iB\b/g, "$1B");
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export function formatDate(value?: number | string | null) {
  const time = value == null || value === "" ? NaN : new Date(value).getTime();
  return Number.isFinite(time) ? formatter.format(time) : "尚未更新";
}
/** Merge equal displayed times while retaining every data source's label. */
export function groupDataTimes(entries: DataTime[]) {
  const groups = new Map<string, { labels: string[]; text: string }>();
  for (const entry of entries) {
    const text = formatDate(entry.value);
    const group = groups.get(text);
    if (group) {
      if (!group.labels.includes(entry.label)) group.labels.push(entry.label);
    } else groups.set(text, { labels: [entry.label], text });
  }
  return [...groups.values()];
}
