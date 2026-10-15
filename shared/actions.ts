export const actions: Record<string, string> = {
  start: "开机",
  stop: "关机",
  reboot: "重启",
  launch: "创建实例",
  command: "执行脚本",
  "install-assistant": "安装云助手",
  "key:create": "创建密钥",
  "key:import": "导入公钥",
  "key:delete": "删除密钥",
  "key:attach": "绑定密钥",
  "key:detach": "解绑密钥",
  "firewall:create": "添加防火墙规则",
  "firewall:modify": "修改防火墙规则",
  "firewall:delete": "删除防火墙规则",
  "firewall:enable": "启用防火墙规则",
  "firewall:disable": "禁用防火墙规则",
  "keepalive-update": "修改保活设置",
  "rule-update": "修改自动化规则",
  "monitor-add": "添加实例",
  "monitor-remove": "移除监控",
  "connection-update": "修改凭证",
  "request-error": "接口请求失败",
  notification: "Telegram 通知",
  "monitor-cycle": "周期检测",
  "billing-refresh": "账单与余额查询",
  "traffic-query": "每日流量查询",
  "notification-queued": "通知入队",
  "notification-sent": "通知发送",
  "notification-retry": "通知发送失败",
  "settings-update": "修改全局设置",
  "account-add": "添加账号",
  "account-update": "编辑账号",
  "terminal-connect": "建立终端会话",
  setup: "初始化面板",
};
export function actionLabel(value: string): string {
  if (actions[value]) return actions[value];
  for (const [prefix, label] of [
    ["manual-", "手动"],
    ["keepalive-", "保活"],
    ["schedule-", "定时"],
    ["traffic-", "流量保护"],
    ["launch-", "初始化"],
  ])
    if (value.startsWith(prefix))
      return label + actionLabel(value.slice(prefix.length));
  return value;
}
