import { ChevronRight } from "lucide-react";

export function InventoryTrafficHeading() {
  return (
    <span className="inventory-traffic-heading">
      <span>本月流量</span>
      <span aria-hidden="true">
        查看明细
        <ChevronRight size={13} />
      </span>
    </span>
  );
}
