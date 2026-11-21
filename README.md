<div align="center">

# Aliyun Panel

**阿里云 ECS 自托管中文管理面板**

实例自动保活 · 共享流量阈值保护 · 每日定时开关机 · 账单与余额查询 · Telegram 通知 · 桌面与移动端适配

[![CI and Docker](https://github.com/haoch1/aliyun-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/haoch1/aliyun-panel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-18181b.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24.5%2B-18181b.svg)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/GHCR-amd64%20%7C%20arm64-18181b.svg)](https://github.com/haoch1/aliyun-panel/pkgs/container/aliyun-panel)

</div>

---

## 简介

**Aliyun Panel** 是面向阿里云 ECS 的轻量级自托管管理面板，采用 **React 19 + TypeScript + Node.js 24 + SQLite** 构建，单容器即可运行，无需独立数据库或消息队列。

- **极简黑白界面**：与 [LightSail Panel](https://github.com/haoch1/lightsail-panel) 共享统一的黑白灰设计体系，支持浅色 / 自动 / 深色一键切换，完整适配桌面、平板与手机端。
- **低占用高可靠**：服务端按需加载官方云产品 SDK，内置 SQLite 快照缓存与过期自动回收；凭证使用 `AES-256-GCM` 加密保存，密码采用 `scrypt` 哈希。
- **内置演示模式**：访问 `/?demo=1` 即可在浏览器内体验完整流程，不访问真实阿里云接口。

## 核心功能

| 模块 | 能力说明 |
| :--- | :--- |
| **实例管理** | 支持接入多个 RAM 凭证与跨地域 ECS 实例；按名称自然排序，支持名称 / ID / IP / 中英文地域搜索及单台、批量开关机 |
| **实例保活** | 后台定时巡检意外停止的实例并自动拉起，严格服从人工停机锁、流量保护熔断与定时关机窗口 |
| **流量保护** | 支持按 CDT 共享流量池百分比或绝对 GiB 阈值触发关机 / 告警，支持可选的流量恢复后自动启动与停机计费模式选择 |
| **定时开关机** | 每日运行时段、跨午夜计划、时区与夏令时自动适配，服务重启后自动补偿当前时段状态 |
| **流量统计** | 本月、近 7 天、近 30 天公网入站 / 出站 / 合计流量；支持 EIP 换绑历史分段追踪、交互式每日柱状图与明细表 |
| **账单与余额** | 同时支持中国站（`aliyun.com`）与国际站（`alibabacloud.com`）BSS 端点，展示月度实例税前费用与账号余额 |
| **Telegram 通知** | 14 类可选通知事件、每日定时汇总、消息实时预览、测试发送及持久化失败重试与限流退避 |
| **运行日志** | 记录检测快照、规则判断、云端动作阶段与请求 ID，支持类型分段筛选、关键词秒搜与自定义保留条数 |

## 快速部署（Docker Compose）

预构建多架构镜像：`ghcr.io/haoch1/aliyun-panel:latest`（支持 `linux/amd64` 与 `linux/arm64`）。

在空目录创建 `compose.yaml`：

```yaml
name: aliyun-panel
services:
  aliyun-panel:
    image: ghcr.io/haoch1/aliyun-panel:latest
    container_name: aliyun-panel
    hostname: aliyun-panel
    restart: unless-stopped
    ports:
      - "127.0.0.1:4182:4182"
    environment:
      HOST: 0.0.0.0
      PORT: 4182
      DATA_DIR: /app/data
      PUBLIC_ORIGIN: ""
    volumes:
      - aliyun-panel-data:/app/data
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
volumes:
  aliyun-panel-data:
    name: aliyun-panel-data
```

启动服务并验证：

```bash
docker compose up -d
curl -fsS http://127.0.0.1:4182/api/health
```

远程服务器可通过 SSH 隧道访问：

```bash
ssh -N -L 4182:127.0.0.1:4182 user@server
```

在浏览器打开 `http://127.0.0.1:4182`，首次访问设置管理员密码，随后点击 **添加实例** 接入 ECS 并在 **系统设置** 中配置检测间隔与 Telegram 通知。

> 更多关于反向代理、环境变量、数据备份与更新的步骤见 [部署文档](docs/deployment.md)。

## 阿里云 RAM 权限配置

推荐在阿里云 RAM 控制台创建专用子账号并启用 AccessKey，按实际使用的功能授予对应策略：

| 策略 | 适用场景 |
| :--- | :--- |
| `AliyunECSFullAccess` | ECS 信息查询、固定公网监控，以及保活、流量保护、定时与手动开关机（如需限定到指定实例，可使用 [受限策略模板](docs/ram-ecs-policy.template.json)） |
| `AliyunCDTReadOnlyAccess` | CDT 月度共享流量池用量与阈值判断 |
| `AliyunBSSReadOnlyAccess` | 月度实例账单与账号余额查询 |
| `AliyunEIPReadOnlyAccess` | 独立弹性公网 IP（EIP）的月流量与每日图表（仅使用独立 EIP 时需要） |

> **站点说明**：账号所属站点（国内站 `aliyun.com` / 国际站 `alibabacloud.com`）与实例所在地域相互独立；例如国内站账号同样可管理中国香港地域实例。

## 数据与安全

- 数据目录默认为容器内 `/app/data`（非 `root` 用户运行），包含 `panel.sqlite` 与 `encryption.key`，**备份时须同时保存这两个文件**。
- 面板仅调用查询与开关机接口，不调用创建、购买、续费或释放云资源接口；面板内“移除监控”不会停止或删除云端 ECS。
- 自动化规则优先级、流量统计口径与通知机制详见 [自动化说明](docs/automation.md) 与 [Telegram 通知文档](docs/notifications.md)。

## 本地开发

环境要求：`Node.js >= 24.5.0`、`pnpm 11.25.0`。

```bash
git clone https://github.com/haoch1/aliyun-panel.git
cd aliyun-panel
pnpm install --frozen-lockfile
pnpm dev        # 启动本地开发服务（支持 /?demo=1 演示模式）
pnpm check      # TypeScript 类型检查
pnpm test       # 运行自动化测试套件
pnpm build      # 构建生产前端资源
```

## 相关文档

- [部署、更新与备份](docs/deployment.md)
- [自动化与调度机制](docs/automation.md)
- [RAM 权限说明](docs/ram-permissions.md)
- [Telegram 通知](docs/notifications.md)
- [API 与查询机制](docs/api-implementation.md)
- [前端组件与交互规范](docs/frontend.md)
- [故障排查](docs/troubleshooting.md)

## 姊妹项目

- [lightsail-panel](https://github.com/haoch1/lightsail-panel) — 同款设计体系的 Amazon Lightsail 自托管管理面板（多账户跨区域管理、网页 SSH、静态 IP、防火墙、流量自动关机与 Telegram 通知）。

## License

[MIT](LICENSE)
