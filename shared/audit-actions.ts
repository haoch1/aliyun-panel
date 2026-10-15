const labels: Record<string, string> = {
  setup: "初始化管理员",
  refresh: "刷新资源",
  "add-account": "添加阿里云凭据",
  "verify-account": "验证阿里云凭据",
  "delete-account": "移除阿里云凭据",
  start: "启动实例",
  stop: "停止实例",
  reboot: "重启实例",
  terminate: "删除实例",
  launch: "创建实例",
  "launch-network": "配置实例网络",
  "operation-complete": "更新资源状态",
  "enable-ipv6": "启用 IPv6",
  "disable-ipv6": "关闭 IPv6",
  "rotate-ip": "更换公网 IP",
  "rotate-ip-rollback": "恢复静态 IP 绑定",
  "rotate-ip-cleanup": "释放临时静态 IP",
  "static-ip-allocate": "分配静态 IP",
  "static-ip-attach": "绑定静态 IP",
  "static-ip-detach": "解绑静态 IP",
  "static-ip-release": "释放静态 IP",
  "open-port": "开放防火墙端口",
  "close-port": "关闭防火墙端口",
  "download-default-key": "下载默认 SSH 私钥",
  "ssh-connect": "SSH 终端",
  "traffic-limit": "设置自动关机",
  "traffic-auto-stop": "执行自动关机",
  "traffic-auto-stop-check": "检查自动关机规则",
};

export function auditActionLabel(action: string) {
  if (Object.hasOwn(labels, action)) return labels[action];
  return /\p{Script=Han}/u.test(action) ? action : `其他操作（${action}）`;
}

const successDetails: Record<string, string> = {
  setup: "管理员配置已初始化",
  refresh: "资源查询完成",
  "add-account": "阿里云身份校验通过，凭据配置已保存",
  "verify-account": "阿里云身份校验通过",
  "delete-account": "账户配置及关联的自动关机规则已移除",
  start: "实例启动操作完成",
  stop: "实例停止操作完成",
  reboot: "实例重启操作完成",
  terminate: "实例删除操作完成",
  launch: "实例创建及所选网络配置完成",
  "launch-network": "实例网络配置完成",
  "operation-complete": "资源状态已更新",
  "enable-ipv6": "IPv6 启用操作完成",
  "disable-ipv6": "IPv6 关闭操作完成",
  "rotate-ip": "公网 IP 更换操作完成",
  "rotate-ip-rollback": "原静态 IP 绑定已恢复",
  "rotate-ip-cleanup": "临时静态 IP 已释放",
  "static-ip-allocate": "静态 IP 已分配",
  "static-ip-attach": "静态 IP 已绑定",
  "static-ip-detach": "静态 IP 已解绑",
  "static-ip-release": "静态 IP 已释放",
  "open-port": "防火墙端口开放操作完成",
  "close-port": "防火墙端口关闭操作完成",
  "download-default-key": "默认 SSH 私钥已获取",
  "ssh-connect": "SSH 连接已建立",
  "traffic-limit": "自动关机规则已保存",
  "traffic-auto-stop": "自动关机操作完成",
  "traffic-auto-stop-check": "自动关机规则检查完成",
};

export function auditDefaultDetail(action: string, status: string) {
  if (status === "submitted") return "请求正在处理，等待执行结果";
  if (status === "failed") return "操作失败，未返回错误详情";
  return Object.hasOwn(successDetails, action)
    ? successDetails[action]
    : "操作已完成";
}
