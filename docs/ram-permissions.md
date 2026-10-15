# RAM 权限

## 系统策略授权

可使用阿里云系统策略授权；采用 `AliyunECSFullAccess` 时无需另行创建自定义 ECS 策略

| 策略                      | 功能                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `AliyunECSFullAccess`     | 实例信息、状态和固定公网 IP 监控查询，以及保活、流量保护、定时和手动开关机 |
| `AliyunCDTReadOnlyAccess` | 月度共享流量、阈值判断和月初恢复判断                                       |
| `AliyunBSSReadOnlyAccess` | 账单和余额                                                                 |
| `AliyunEIPReadOnlyAccess` | 独立 EIP 的每日流量图表                                                    |

在目标 RAM 用户的「权限管理 → 新增授权」中添加所需系统策略，已有授权保留；不需要更换 AccessKey、修改面板代码或重启服务

面板按具体 API 调用，不判断策略名称；开关机仍只调用 `StartInstance` / `StopInstance`，没有创建、购买或释放云资源的功能

`AliyunECSFullAccess` 授予的能力比面板实际使用的多，包含全部 ECS 操作；授权本身不会购买资源，但启动已有实例、保留资源停机以及实际流量仍遵循原有计费规则

Telegram 通知与本地日志不需要额外的阿里云权限，通知中的云端数据沿用以上读取结果

## 可选的受限 ECS 策略

需要缩小 ECS 操作范围时，可用自定义策略替代 `AliyunECSFullAccess`

复制 [策略模板](ram-ecs-policy.template.json)，将 `<REGION_ID>`、`<ACCOUNT_ID>`、`<INSTANCE_ID>` 换成实例地域、阿里云主账号 ID 和 ECS 实例 ID

| 操作                              | 功能                                       | 资源范围         |
| --------------------------------- | ------------------------------------------ | ---------------- |
| `ecs:DescribeInstances`           | 接入实例、状态与公网 IP 查询、动作结果核实 | 账号内实例，只读 |
| `ecs:DescribeInstanceMonitorData` | 固定公网 IP 的每日流量图表                 | 指定实例         |
| `ecs:StartInstance`               | 保活、定时开机、手动开机、流量保护恢复     | 指定实例         |
| `ecs:StopInstance`                | 流量关机、定时关机、手动关机               | 指定实例         |

实例查询保留账号级只读范围，兼容添加实例时的地域识别；监控读取和开关机限定到明确列出的实例 ARN

多台实例需要在第二条语句的 `Resource` 数组中逐台添加完整 ARN；新增监控实例前也要补充这一范围

策略不授予创建、购买、续费、删除、释放、改配、磁盘操作、安全组修改、远程命令或 RAM 管理权限

`DescribeRegions` 和 `GetCallerIdentity` 在官方文档中标记为无需额外授权，不添加对应权限

### 其他读取权限

替换 ECS 策略时，保留或补充以下只读策略

| 策略                      | 功能                                 |
| ------------------------- | ------------------------------------ |
| `AliyunCDTReadOnlyAccess` | 月度共享流量、阈值判断和月初恢复判断 |
| `AliyunBSSReadOnlyAccess` | 账单和余额                           |
| `AliyunEIPReadOnlyAccess` | 独立 EIP 的每日流量图表              |

EIP 图表也可以用仅允许 `vpc:DescribeEipMonitorData`、资源为指定 EIP ARN 的自定义策略替代系统只读策略；无需 VPC 或 EIP 全权限

### 可选替换步骤

1. 在 RAM「权限策略」中创建自定义策略，使用填好实例信息的 JSON，名称可用 `AliyunPanelEcsControl`
2. 在目标 RAM 用户的「权限管理 → 新增授权」中添加这个自定义策略
3. 解除该用户已有的 `AliyunECSFullAccess`；只有解除旧策略后，操作范围才会收紧
4. 核对是否通过用户组或角色仍继承 ECS 全权限；保留上表中所需的其他只读授权
5. 替换后先检查实例、账单与图表读取，再用 `StartInstance` / `StopInstance` 的 `DryRun=true` 核验权限；`DryRunOperation` 代表校验通过，不会实际开关机

受限策略覆盖当前代码需要的操作，本地测试使用模拟接口验证调用覆盖与指定实例边界；真实 RAM 授权结果仍需替换后核验，显式拒绝策略、用户组继承权限、实例锁定和欠费也可能影响结果

## 官方依据

- [ECS 全权限策略](https://www.alibabacloud.com/help/en/ram/developer-reference/aliyunecsfullaccess)
- [DescribeInstances](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-describeinstances)
- [DescribeInstanceMonitorData](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-describeinstancemonitordata)
- [StartInstance 与 DryRun](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-startinstance)
- [StopInstance 与 DryRun](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-stopinstance)
- [DescribeRegions](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-describeregions)
- [GetCallerIdentity](https://www.alibabacloud.com/help/en/ram/developer-reference/api-sts-2015-04-01-getcalleridentity)
- [CDT 只读策略](https://www.alibabacloud.com/help/en/ram/developer-reference/aliyuncdtreadonlyaccess)
- [BSS 只读策略](https://www.alibabacloud.com/help/en/ram/developer-reference/aliyunbssreadonlyaccess)
- [EIP 只读策略](https://www.alibabacloud.com/help/en/ram/developer-reference/aliyuneipreadonlyaccess)
