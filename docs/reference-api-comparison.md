# 参考实现与 API 对照

对照版本：CDT-Monitor `ad152f0` 与 aliyun-guard `2c86ada`，核对日期 2026-10-15

| 功能           | CDT-Monitor                                                  | aliyun-guard                                            | 当前面板                                                           |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| 状态与保活判断 | `DescribeInstanceStatus`                                     | 按凭据、地域分组的 `DescribeInstances`                  | 按账号、地域分组的 `DescribeInstances`，同一响应更新状态与公网绑定 |
| 月流量         | `ListCdtInternetTraffic`，账号共享流量池                     | 相同接口，同轮账号缓存                                  | 相同接口，同轮账号缓存，内地与非内地额度分别处理                   |
| 历史流量       | 将查询得到的累计流量写入 SQLite，历史页面读取本地快照        | 将检测历史写入本地状态文件                              | 打开流量页面时按需查询 EIP/ECS 监控，历史持久化，后续增量查询      |
| 正常检测周期   | `APIInterval` 到期才查询；过渡状态、整点、手动及定时动作例外 | `interval_seconds` 到期才查询；启动、月初及定时边界例外 | `checkInterval` 到期才查询；启动、手动刷新、月初及定时边界例外     |
| 开关机         | ECS `StartInstance` / `StopInstance`                         | 相同接口                                                | 相同接口；提交后独立查询结果，避免把请求成功当成实例已完成动作     |

## 查询与调度设计

- 常规实例查询遵循检测间隔，不设置独立的固定五分钟发现任务
- 后台查询的同一个 `DescribeInstances` 响应同时更新状态、公网 IP 与 EIP 标识，无需另起发现请求
- 点击刷新并检查规则时复用同轮状态响应
- 保留定时边界、月初流量恢复和在途任务结果核实，不因设置较长检测间隔而延迟这些动作
- 网络类只读失败最多尝试 3 次；权限拒绝不重试；开关机写请求不由 SDK 自动重放
- 每日流量查询失败保留成功历史；瞬时网络错误冷却 1 分钟，其他错误冷却 5 分钟；冷却本身不会定时发出监控请求

## 每日流量口径

CDT-Monitor 的历史来自账号共享流量池累计快照，不能自动补齐安装前的历史，也不能直接视作某台 ECS 的独立用量

当前面板的每日图表来自公网监控数据，月流量和关机阈值仍使用账号共享流量池。额外监控接口仅在打开流量页面或手动刷新时按需调用，已有历史缓存不重复全量拉取

## 审计记录

阿里云官方 ECS 审计事件列表同时包含 `DescribeInstanceStatus` 和 `DescribeInstances`，语言、手写 RPC 签名与官方 SDK 的差异不代表其中一种不会被审计

核对实际轮询频率时，应在实例所在地域按 ECS 服务、事件名、时间及该 RAM 用户/AccessKey 筛选。`LookupEvents`、`ListEventNames` 属于操作审计查询接口，本面板没有调用这些接口

代码依据：

- [CDT-Monitor 阿里云客户端](https://github.com/wang4386/CDT-Monitor/blob/ad152f0/internal/aliyun/client.go)
- [CDT-Monitor 检测调度](https://github.com/wang4386/CDT-Monitor/blob/ad152f0/internal/engine/engine.go)
- [CDT-Monitor 本地流量历史](https://github.com/wang4386/CDT-Monitor/blob/ad152f0/internal/store/runtime.go)
- [aliyun-guard 接口与调度](https://github.com/Felix666-ship-It/aliyun-guard/blob/2c86ada/src/aliyun_guard.py)
- [阿里云 ECS 审计事件](https://www.alibabacloud.com/help/en/actiontrail/product-overview/audit-events-of-ecs)
- [操作审计控制台事件查询范围与筛选](https://help.aliyun.com/en/actiontrail/user-guide/query-events-in-the-actiontrail-console)
