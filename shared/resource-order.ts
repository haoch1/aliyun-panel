type NamedResource = {
  name?: string;
  region?: string;
  id?: string;
  accountId?: string;
};

const names = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});
const exact = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

export function sortByName<T extends NamedResource>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      names.compare(a.name || a.id || "", b.name || b.id || "") ||
      exact(a.name, b.name) ||
      exact(a.region, b.region) ||
      exact(a.id, b.id) ||
      exact(a.accountId, b.accountId),
  );
}
