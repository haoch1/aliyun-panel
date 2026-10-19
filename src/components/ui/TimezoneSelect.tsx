import Select from "./Select";

const zones = [
  ["Asia/Shanghai", "北京时间 · Asia/Shanghai"],
  ["Asia/Hong_Kong", "香港时间 · Asia/Hong_Kong"],
  ["Asia/Singapore", "新加坡时间 · Asia/Singapore"],
  ["Asia/Tokyo", "东京时间 · Asia/Tokyo"],
  ["Asia/Seoul", "首尔时间 · Asia/Seoul"],
  ["Asia/Bangkok", "曼谷时间 · Asia/Bangkok"],
  ["Asia/Kolkata", "印度时间 · Asia/Kolkata"],
  ["Asia/Dubai", "迪拜时间 · Asia/Dubai"],
  ["Europe/London", "伦敦时间 · Europe/London"],
  ["Europe/Berlin", "柏林时间 · Europe/Berlin"],
  ["America/New_York", "美国东部时间 · America/New_York"],
  ["America/Los_Angeles", "美国太平洋时间 · America/Los_Angeles"],
  ["Australia/Sydney", "悉尼时间 · Australia/Sydney"],
  ["UTC", "协调世界时 · UTC"],
];

export default function TimezoneSelect({
  value,
  onChange,
  disabled,
  id,
  "aria-describedby": description,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const options = zones.some(([zone]) => zone === value)
    ? zones
    : [...zones, [value, value]];
  return (
    <Select
      id={id}
      aria-label="时区"
      searchable
      aria-describedby={description}
      value={value}
      disabled={disabled}
      required
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(([zone, label]) => (
        <option key={zone} value={zone}>
          {label}
        </option>
      ))}
    </Select>
  );
}
