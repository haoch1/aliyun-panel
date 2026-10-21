# 部署与运维

## 统一命名

| 项目                             | 标识                                 |
| -------------------------------- | ------------------------------------ |
| 产品名称                         | Aliyun Panel                         |
| 仓库、npm 包、Compose 项目与服务 | `aliyun-panel`                       |
| 容器名称与主机名                 | `aliyun-panel`                       |
| 启动命令、Linux 进程与线程名     | `aliyun-panel`                       |
| 默认镜像                         | `ghcr.io/haoch1/aliyun-panel:latest` |
| 数据卷                           | `aliyun-panel-data`                  |
| 容器内部端口 / 默认宿主机端口    | `4182` / `4182`                      |
| 容器数据目录                     | `/app/data`                          |

Linux 启动后同步进程及线程名称，后续创建的线程会周期性同步；此操作不增加进程权限。Windows 和 macOS 保留平台自身的线程管理方式

## Docker Compose

按照 README 创建 Compose 文件，或克隆仓库后使用提供的配置：

```sh
git clone https://github.com/haoch1/aliyun-panel.git
cd aliyun-panel
cp .env.example .env
docker compose pull
docker compose up -d
docker compose ps
```

默认绑定 `127.0.0.1:4182`，仅部署主机可访问。修改宿主机端口可在 `.env` 中设置 `PANEL_PORT=8091`，容器内部仍使用 4182

需要从局域网直接访问时，可将 `PANEL_BIND` 设置为相应网卡地址，并通过主机防火墙限制来源；公网访问应使用 HTTPS 反向代理

### 环境变量

| 变量                                      | 默认值                               | 说明                                                                  |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `PANEL_IMAGE`                             | `ghcr.io/haoch1/aliyun-panel:latest` | 仓库 Compose 使用的镜像                                               |
| `PANEL_BIND`                              | `127.0.0.1`                          | 宿主机绑定地址                                                        |
| `PANEL_PORT`                              | `4182`                               | 宿主机端口                                                            |
| `PUBLIC_ORIGIN`                           | 空                                   | 完整对外 Origin，例如 `https://panel.example.com`，不带路径或末尾斜杠 |
| `HOST`                                    | 原生部署 `127.0.0.1`；容器 `0.0.0.0` | 服务监听地址                                                          |
| `PORT`                                    | `4182`                               | 服务内部端口                                                          |
| `DATA_DIR`                                | 原生部署 `./data`；容器 `/app/data`  | 数据目录                                                              |
| `ENCRYPTION_KEY`                          | 未设置                               | 可选，Base64 编码的 32 字节密钥，替代自动生成的密钥文件               |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 未设置                               | Telegram 传输代理及绕过列表，也支持小写形式                           |

宿主机 `.env` 用于 Compose 变量替换，**不会自动把任意变量注入容器**。代理和自定义密钥需显式添加到 Compose 的 `environment`，或使用覆盖文件：

```yaml
services:
  aliyun-panel:
    environment:
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      HTTP_PROXY: ${HTTP_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1}
```

代理地址必须能由容器访问；容器内的 `127.0.0.1` 指向容器自身。也可在通知设置中填写自有 Telegram API 反向代理地址

首次启动后不要随意更换 `ENCRYPTION_KEY`，已有加密凭据需要原始密钥解密

### HTTPS 反向代理

Compose 保持回环绑定，设置 `PUBLIC_ORIGIN=https://panel.example.com`，由 Nginx 提供 TLS：

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4182;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

API 使用 SSE 推送刷新事件，因此需要关闭代理缓冲。设置 HTTPS Origin 后，会话 Cookie 使用 Secure 标记；浏览器应始终通过该 HTTPS 域名访问

## 更新与版本固定

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail 100 aliyun-panel
```

更新复用同名数据卷，不需要重新初始化或填写凭据。生产部署可将 `PANEL_IMAGE` 固定为版本标签、`sha-<完整提交>` 或镜像摘要

回退时恢复原镜像标识后重新部署；若新版本修改数据库结构，应使用更新前备份恢复数据，不能假定旧版本兼容新数据库

## 备份与恢复

备份必须同时包含数据库和加密密钥。建议停止服务后备份，避免遗漏 SQLite WAL 中尚未合并的写入

```sh
mkdir -p backups
docker compose stop
docker run --rm --network none \
  -v aliyun-panel-data:/data:ro -v "$PWD/backups:/backup" \
  --entrypoint tar ghcr.io/haoch1/aliyun-panel:latest \
  -czf /backup/aliyun-panel-data.tar.gz -C /data .
docker compose start
```

备份包含认证和云端凭据，应限制访问并离线保存。使用环境变量密钥时，另行备份该密钥

恢复前停止服务，将备份解压到目标数据卷，保留文件权限，再启动兼容版本。不要在空目录初始化后混入另一套密钥，也不要让多个面板进程同时操作同一数据目录

`docker compose down` 保留数据卷，`docker compose down --volumes` 会删除数据，仅在明确需要清空数据时使用后者

## 源码部署

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm start
```

要求 Node.js 24.5+，运行依赖内置 SQLite 和 TypeScript 类型擦除能力。原生运行时从当前工作目录读取 `.env`；应从项目根目录启动，或显式设置绝对 `DATA_DIR`

后台运行可交由 systemd 管理，将 WorkingDirectory 设置为项目根目录，使用专用非特权用户，对数据目录授予写入权限。停止使用 SIGTERM，服务等待在途任务完成，最长约 20 秒

从源码构建容器：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## 健康检查

```sh
docker exec aliyun-panel aliyun-panel --healthcheck
curl --fail http://127.0.0.1:4182/api/health
```

健康检查验证 HTTP 服务可用，不会调用阿里云或触发开关机，也不代表云端权限、账单与 Telegram 通道均已验证。具体状态应结合面板数据时间和日志判断

健康检查在加载数据库和业务模块之前执行，仅发送本地 HTTP 请求，避免每次探测重复加载云产品 SDK

## 内存与缓存

云产品 SDK 在首次使用该产品时加载，继续使用官方请求、签名和响应模型。没有使用 EIP 监控时无需加载 VPC SDK；已加载的模块由 Node.js 复用

接口结果缓存按原有效期失效，每 30 秒清理过期项，结果缓存与客户端缓存各最多保留 128 项，超出时淘汰最久未使用的项目。缓存未命中会重新查询，不删除 SQLite 中的日志、流量历史或配置。时区格式器按时区复用，最多缓存 32 个时区，日期和夏令时仍按每次请求的时间计算

```sh
docker stats --no-stream aliyun-panel
```

内存会随首次使用的云产品、管理规模、历史查询和垃圾回收变化。评估优化效果应在相同配置和工作负载下比较，重启后的短时低值不能代表长期占用；不要仅凭一次读数判断内存泄漏
