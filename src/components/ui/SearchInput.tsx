import { Search, X } from "lucide-react";
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索名称、实例 ID 或 IP…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search">
      <Search size={15} />
      <input
        aria-label="搜索资源"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          className="icon-button"
          aria-label="清除搜索"
          onClick={() => onChange("")}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
