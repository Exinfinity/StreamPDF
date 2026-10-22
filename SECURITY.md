# 安全策略

本文档说明 StreamPDF 的威胁模型、安全默认值、支持版本、漏洞上报方式，以及内网部署时必须完成的主机/容器/反向代理加固清单。当前版本按**内网部署**设计，默认允许访问私网、回环/宿主服务和任意端口。

相关文档：

- [SECURITY-AUDIT.md](SECURITY-AUDIT.md)：完整安全审计与修复复核记录。
- [README.md](README.md)：功能、配置与使用说明。
- [deploy/](deploy/)：systemd、nginx、Docker/Compose 加固模板。

## 支持版本

| 版本 | 安全支持 | 说明 |
| --- | --- | --- |
| `1.0.x`（当前） | ✅ | 需要 Node.js `>=22.13.0`（PDF.js 6.x 要求） |
| 更早提交 | ❌ | P0/P1 漏洞未修复，禁止部署到不受信网络 |

依赖策略：

- `pdfjs-dist` 必须保持在 `>=6.2.108`（CVE-2026-16633 / GHSA-hq66-cqwq-w95j 修复版本）；当前锁定 `^6.4.299`。
- `package-lock.json` 必须提交，CI 使用 `npm ci` 保证可复现安装。
- CI 每次推送/PR 运行 `npm audit --omit=dev --audit-level=high`，每周一次定时扫描。
- Dependabot 每周检查 npm 依赖与 GitHub Actions 版本。

## 威胁模型

### 部署假设

```text
内网用户浏览器
  → 可选内网反向代理（TLS、Host 白名单、限流、可选身份认证）
  → StreamPDF Node 进程（127.0.0.1:3000 或内网地址）
      → 允许内网/本机/公网 HTTP(S) Range 请求（默认不限端口）
```

- 默认部署目标是**可信内网**：Node 进程不应直接暴露到公网；内网访问也应通过防火墙/反向代理限制来源。
- 默认策略**有意放宽**了目标地址限制：允许 RFC1918 私网、CGNAT、IPv6 ULA、回环/宿主服务与任意端口；仍阻断链路本地/云元数据、组播、保留地址和 IPv6 转换隧道地址。
- 应用自身提供 Bearer 令牌、Host 白名单、Origin 校验、资源上限与日志脱敏，但这些是**纵深防御**，不替代代理层认证与网络层访问控制。
- 服务器**不读取任何客户端指定的本地文件**，也不把 PDF 落盘；只代理 HTTP(S) Range 请求。
- 如果实例可能被不受信客户端访问，设置 `ALLOW_PRIVATE_ADDRESSES=0` 恢复“仅公网地址 + 端口白名单”的严格模式。

### 防护目标

| 威胁 | 控制措施 |
| --- | --- |
| 服务器本地文件读取（LFI） | 已删除路径模式与服务端文件读取，只接受 HTTP(S) URL |
| SSRF / 云元数据 | 默认内网模式仅阻断链路本地/云元数据、组播、保留地址与 IPv6 隧道地址；DNS pinning、逐跳重定向校验；可选公网严格模式（`ALLOW_PRIVATE_ADDRESSES=0`）恢复公网 IP 校验与端口白名单 |
| 内网横向访问 | **刻意放宽**：默认允许私网/回环/宿主服务与任意端口，供内网 PDF 源使用；应只在可信内网部署，并配合网络层访问控制 |
| 未认证访问 | 除 `/api/health` 外全部 `/api/*` 要求 `Authorization: Bearer`，认证失败限流 |
| Host 头注入 / DNS rebinding | Host 白名单；非回环绑定必须设置 `ALLOWED_HOSTS` |
| 跨站请求伪造（CSRF） | 无 Cookie 会话；状态变更接口额外校验 `Origin` / `Sec-Fetch-Site`（`ALLOWED_ORIGINS`） |
| 资源耗尽 / DoS | 文档数、每 IP 配额、并发流、请求限流、上游超时、响应大小、Node HTTP 超时 |
| 恶意 PDF 脚本执行 | PDF.js 升级、`enableScripting: false`、`enableXfa: false`、严格 CSP、`/content` sandbox CSP |
| 敏感内容缓存 | API 与 `/content` 全部 `Cache-Control: no-store` |
| 信息泄露 | 元数据最小化、错误脱敏、结构化日志脱敏、可选指标接口需认证 |
| 通配符/危险协议书签 | 前端 outline URL 仅允许 `http:` / `https:` / `mailto:`，拒绝内嵌凭据 |
| 日志注入 / 密钥落日志 | 结构化 JSON 日志，自动脱敏 Authorization/Cookie/token/URL query/绝对路径/控制字符 |

### 不在防护范围

- 反向代理、容器编排、主机内核与内网防火墙的配置错误。
- 内网模式有意允许访问 RFC1918/CGNAT/回环与任意端口；被授权的内网用户可借此读取同网段其他 HTTP 服务或 PDF 文件。这是内网部署的预期能力，不是漏洞。
- 运维人员主动泄露 `AUTH_TOKEN` 或关闭 HTTPS。
- 浏览器、PDF.js 或第三方依赖的 0-day；请通过依赖升级与隔离域名降低影响。
- 对 PDF 解析器的深度 fuzzing 与真实浏览器渲染差异（见审计报告“审计限制”）。

## 安全默认值

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 只监听回环；非回环绑定必须同时设置 `ALLOWED_HOSTS` 与 `AUTH_TOKEN` |
| `AUTH_TOKEN` | 随机生成 | 非回环绑定必须显式设置；交互式终端会打印随机令牌，非交互进程写入 `./.auth-token`（0600），失败则拒绝启动 |
| `ALLOWED_HOSTS` | 仅回环主机名 | 不匹配返回 421；反向代理应传递原始 `Host` |
| `ALLOWED_ORIGINS` | 空 | 仅接受同源状态变更请求；独立前端域名必须显式配置 |
| `ALLOW_PRIVATE_ADDRESSES` | `1` | 内网模式：允许私网、CGNAT、IPv6 ULA、回环/宿主地址与任意端口；`0` 恢复仅公网地址 + 端口白名单 |
| `ALLOWED_REMOTE_PORTS` | `80,443` | 仅在 `ALLOW_PRIVATE_ADDRESSES=0` 的公网严格模式下生效 |
| `ENABLE_HSTS` | 空 | 仅在 HTTPS 反向代理后设为 `1` |
| `ENABLE_METRICS` | 空 | 设为 `1` 时开放需认证的 `/api/metrics` 聚合指标 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `METRICS_LOG_INTERVAL_MINUTES` | `15` | 周期性输出 `metrics.snapshot`；`0` 关闭 |

完整变量表见 [README.md](README.md#配置)。

## 内网部署清单

### 1. 网络与进程

- [ ] Node 只监听 `127.0.0.1`（由内网反向代理接入）或明确的内网地址；不要映射到公网。
- [ ] 防火墙/安全组只允许可信内网网段访问服务端口。
- [ ] 默认策略允许访问 RFC1918、回环与宿主服务；如只应访问特定文件服务器，在主机/容器/防火墙层按网段和端口收紧。
- [ ] 链路本地/云元数据地址在应用层仍被阻断；如部署在云主机，额外在主机层阻断 `169.254.169.254`。
- [ ] 非 root 用户运行；根文件系统只读；`PrivateTmp`、`no-new-privileges`、`cap_drop: ALL`、seccomp。
- [ ] 设置 `MemoryMax`、`TasksMax`、`LimitNOFILE` / 容器 memory、pids 限制。
- [ ] 使用 [deploy/streampdf.service](deploy/streampdf.service)、[deploy/Dockerfile](deploy/Dockerfile)、[deploy/docker-compose.yml](deploy/docker-compose.yml) 作为起点。

### 2. 认证与访问控制

- [ ] 设置强随机 `AUTH_TOKEN`（至少 32 字节随机值），通过 `EnvironmentFile`/Secret 注入，不写入镜像或仓库。
- [ ] 若内网客户端不完全可信，在反向代理层再做一次认证（Basic Auth、OAuth2-proxy 等）。
- [ ] 设置 `ALLOWED_HOSTS` 为真实内网域名/IP；代理发送 `proxy_set_header Host $host`。
- [ ] 仅在使用独立前端域名时配置 `ALLOWED_ORIGINS`；不要使用 `*`。
- [ ] 在代理层配置 `limit_req`、`limit_conn`、`client_max_body_size 64k`。

### 3. TLS 与响应头

- [ ] 内网同样建议启用 HTTPS；启用 HSTS（代理层和/或 `ENABLE_HSTS=1`，仅限 HTTPS 场景）。
- [ ] 保留应用发送的 CSP、COOP、CORP、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`。
- [ ] 不要通过代理删除 `/api/*` 的 `Cache-Control: no-store`。

### 4. 日志与监控

- [ ] 应用日志为单行 JSON，可直接送 SIEM；禁止把 `Authorization`、Cookie、token 或完整 URL 写入日志。
- [ ] 告警：认证失败突增、429 突增、5xx 比例、上游失败/超时、文档数接近上限、并发流接近上限、进程内存/文件描述符。
- [ ] 可选：`ENABLE_METRICS=1` 后由代理侧带 Bearer 令牌抓取 `/api/metrics`；只在内网开放该端点。
- [ ] 定期检查 `.auth-token` 文件（若使用非交互随机令牌模式）权限为 0600，并尽快改为显式 `AUTH_TOKEN`。

### 5. 供应链与发布

- [ ] CI 必须通过 `npm ci`、`npm test`、`npm audit --omit=dev --audit-level=high`。
- [ ] 合并前检查 Dependabot/Renovate PR，尤其是 `pdfjs-dist` 与 `express`。
- [ ] 固定 Node 大版本（22.x 或 24.x），构建镜像使用 `node:24-bookworm-slim` 或同等最小基础镜像。
- [ ] 不在镜像中保留 `.git`、`.env`、测试数据、`test-pdf/`。

## 日志字段与脱敏

应用以单行 JSON 输出，示例：

```json
{"time":"2026-10-22T04:00:00.000Z","level":"info","event":"document.opened","requestId":"…","ip":"203.0.113.10","documentId":"…","size":12345,"display":"cdn.example.com/files/a.pdf"}
```

- `Authorization`、`Cookie`、`token`、`password`、`secret`、`session` 等键的值一律替换为 `[redacted]`。
- URL 只保留 `scheme://host/path`，丢弃 userinfo、query 与 fragment。
- 引号包裹的绝对路径只保留 basename；错误日志不包含堆栈。
- 控制字符与 Unicode 双向覆盖字符（`U+202A–U+202E`、`U+2066–U+2069` 等）被移除，防止日志/文件名欺骗。
- `X-Request-Id` 同时返回给客户端，便于与代理日志关联；它不含任何秘密。

## 漏洞上报

请**不要**在公开 issue、讨论区或 PR 中披露未修复漏洞。请通过仓库托管平台的私密安全公告（GitHub Security Advisories）联系维护者，并尽量提供：

1. 受影响版本/提交与部署方式（内网还是公网、是否在反向代理后、是否设置 `ALLOWED_ORIGINS` 等）。
2. 复现步骤、最小请求/文件样本、实际影响。
3. 是否暴露到不受信网络、是否观察到利用迹象。

维护者会在确认后尽快给出处置计划；修复发布前请保持信息保密。**请勿**在真实生产实例上执行可能影响可用性的测试（如大规模扫描、资源耗尽、DNS rebinding 演练）。

## 已知安全限制

- 远端必须支持 Range；不支持 Range 的地址会被拒绝（不会落盘缓存）。
- `AUTH_TOKEN` 是单一共享令牌，不区分用户，也没有“文档属于谁”的概念；多租户场景应在反向代理层接入身份系统。
- `ALLOWED_ORIGINS` 只保护状态变更请求；读取接口没有 CORS 头，浏览器无法跨源读取响应。
- 内网模式默认允许访问私网、回环/宿主服务和任意端口，这是刻意的策略放宽：持有有效令牌的内网用户可以让服务端读取同网段可访问的 HTTP(S) 资源。只应在可信内网部署；需要隔离时设 `ALLOW_PRIVATE_ADDRESSES=0` 并配置出站防火墙。
- 链路本地/云元数据（如 `169.254.169.254`、`100.100.100.200`）、组播、保留地址和 IPv6 转换隧道地址在默认策略下仍被阻断。
- 应用层地址策略不能替代出站防火墙；请按实际网络环境同时配置。
- 随机令牌仅在本地交互式开发时方便；生产环境必须显式设置 `AUTH_TOKEN`。
