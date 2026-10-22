# StreamPDF 公网暴露安全审计报告（含 2026-10-21 / 2026-10-22 修复复核）

- **审计对象**：`/mnt/h/Projects/StreamPDFPreviewer`（commit `4edb5f7`）
- **审计日期**：2026-10-21
- **复核日期**：2026-10-21（P0 修复后）、2026-10-22（P2/P3 加固后）
- **审计范围**：`server/`、`public/`、`package.json` / `package-lock.json`、运行配置与 README
- **审计方法**：源码审计 + `npm audit --omit=dev` + 在 `127.0.0.1` 临时端口上的动态验证（未修改生产数据）
- **复核结论**：**P0-1 ~ P0-5、P1-1 ~ P1-3、P2-1 ~ P2-5 与 P3 加固项均已处理**（URL-only 模式、SSRF 防护、Bearer 认证、PDF.js 升级、资源限制、Host 白名单、信息脱敏、移除自动打开；安全响应头、目录链接白名单、CSRF/Origin 防护、临时目录清理、文件名/双向文本加固；结构化脱敏日志、指标、CI/依赖扫描、SECURITY.md、systemd/nginx/Docker 加固模板）。`npm test` 67/67 通过，`npm audit --omit=dev` 为 0 漏洞。公网部署前仍应在反向代理层限制 `Host` 并完成主机/网络层出站限制。
- **原始结论**：修复前版本不能直接暴露到公网。至少存在 3 个未认证即可利用的阻断级问题（任意本地 PDF 读取、SSRF、全站无认证），以及拒绝服务、Host 头/DNS rebinding、信息泄露等问题。

---

## 1. 执行摘要

| ID | 级别 | 问题 | 关键位置 | 公网可利用性 | 修复状态（2026-10-21 复核） |
| --- | --- | --- | --- | --- | --- |
| P0-1 | **严重** | 未认证任意本地文件读取（LFI），默认不限制目录 | `server/sources.js:44-72`、`:471-490` | 任何人可读取服务器上任意 PDF，并可探测任意文件是否存在 | **已修复**：删除路径模式与服务端文件读取 |
| P0-2 | **严重** | 未认证 SSRF：服务端代任意 URL，可访问回环/内网/云元数据 | `server/sources.js:120-207`、`:266-313` | 任何人可扫描内网、读取内网 PDF、向内网 GET 接口发请求 | **已修复**：公网 IP 校验 + DNS pinning + 重定向逐跳校验 |
| P0-3 | **严重** | 全站无认证/授权；文档 ID 即能力令牌 | `server/app.js:36-114` | 任何人可创建会话、读内容、删会话、耗尽资源 | **已修复**：Bearer 令牌 + 认证失败限流 |
| P0-4 | **高** | `pdfjs-dist@5.7.284` 命中高危漏洞 GHSA-hq66-cqwq-w95j（CVE-2026-16633） | `package.json` | 当前代码有多层缓解，但依赖仍应升级 | **已修复**：升级到 6.4.299，显式关闭脚本 |
| P0-5 | **高** | 资源耗尽/拒绝服务：文档数、镜像磁盘、并发、上游超时均无上限 | `server/documents.js:10-44`、`server/sources.js:266-313` | 任何人可耗尽磁盘/连接/带宽 | **已修复**：数量/并发/超时/大小/速率限制；移除镜像 |
| P1-1 | **高** | `Host` 头未校验，存在 DNS rebinding 前置条件 | `server/host.js`、`server/app.js`、`server/index.js` | 恶意网页可借 DNS rebinding 读取本地实例 | **已修复（2026-10-21 第二轮）**：Host 白名单，不匹配返回 421；非回环绑定必须配置 `ALLOWED_HOSTS` |
| P1-2 | **高** | 信息泄露：绝对路径、文件系统错误、内网主机/状态、会话计数 | `server/documents.js`、`server/sources.js` | 辅助 LFI/SSRF，泄露服务器布局 | **已修复（2026-10-21 第二轮）**：元数据最小化，远端错误不再回显状态码/主机/端口，API 全部 `no-store` |
| P1-3 | **中** | `?path=` / `?url=` / `?open=` 在页面加载时自动触发服务端读取 | `public/js/app.js` | 诱导点击即可触发 LFI/SSRF（drive-by） | **已修复**：移除全部自动打开参数，并加入静态回归测试 |
| P2-1 | **中** | 安全响应头不完整；敏感 PDF 可缓存 1 小时 | `server/app.js:309-353` | 缺少 HSTS/COOP/CORP/Permissions-Policy，缓存残留 | **已修复（2026-10-22 复核）**：补齐安全头，内容响应 `no-store` + `sandbox` CSP |
| P2-2 | **中** | PDF 目录项 `item.url` 未校验协议即 `window.open` | `public/js/app.js:804-824` | 恶意 PDF 可能触发 `javascript:`/自定义协议 | **已修复（2026-10-22 复核）**：仅允许 http/https/mailto，拒绝内嵌凭据，保留 `noopener,noreferrer` |
| P2-3 | **中** | 无 CSRF/Origin 防护；若日后加 Cookie 认证会立即中招 | `server/app.js:54-85` | 当前无 Cookie，风险较低，但设计上应提前防护 | **已修复（2026-10-22 复核）**：状态变更接口校验 `Origin` / `Sec-Fetch-Site`，`ALLOWED_ORIGINS` 白名单；Bearer 头认证继续规避 CSRF |
| P2-4 | **中** | 临时镜像清理不完整（崩溃/退出残留），镜像上限可配置得过大 | `server/documents.js:67-84`、`server/index.js:27-48` | 磁盘残留与配额风险 | **已修复（2026-10-22 复核）**：取消临时镜像落盘；启动清理旧版本 `stream-pdf-*` 残留 |
| P2-5 | **低** | Windows 下 `PDF_ALLOWED_ROOTS` 大小写/短文件名比较问题 | `server/sources.js:482` | 可能误拒或边界绕过（取决于平台） | **已失效 + 已加固**：本地路径模式已删除；文件名控制字符/双向覆盖/长度已加固 |
| P3 | **加固** | 依赖 CI、容器/主机加固、日志脱敏、监控告警 | 部署层 | 降低长期风险 | **已修复（2026-10-22 复核）**：CI/Dependabot、结构化脱敏日志、指标、SECURITY.md、systemd/nginx/Docker 模板 |

> **级别说明**：P0 = 公网暴露前必须修复；P1 = 暴露前应修复；P2 = 首周内修复；P3 = 持续加固。

---

## 1.1 修复复核详情（2026-10-21）

复核对象为工作区中 P0 修复后的代码。P0-1 ~ P0-5 已关闭，验证命令与结果见本节末尾。

### P0-1 已修复：彻底删除服务器本地文件读取

- 删除 `source: "path"`、`PDF_ALLOWED_ROOTS`、`inspectLocalSource()`、`assertAllowedRoot()`、本地文件探测/读取与临时镜像逻辑。
- `POST /api/documents` 只接受 HTTP(S) URL；传入 `source: "path"` 返回 `403 LOCAL_FILES_DISABLED`，传入文件路径字符串返回 `400 INVALID_URL`。
- 服务端不再 import `node:fs`，不存在任何由客户端指定的文件系统读取路径。
- `publicInfo()` 不再返回 `location` 绝对路径；错误响应不再回显文件路径/errno。
- 前端删除“本地文件路径”入口、路径最近记录和 `?path=` 自动打开。
- 由于不再镜像不支持 Range 的远端文件，服务端也没有临时 PDF 落盘；此类远端返回 `422 REMOTE_NO_RANGE`。

### P0-2 已修复：URL 代理增加 SSRF 防护

新增 `server/http-client.js`，所有远端请求统一经过该客户端：

- 仅允许 `http:` / `https:`；拒绝 URL 内嵌用户名/密码；默认只允许 80/443 端口（`ALLOWED_REMOTE_PORTS` 可调整）。
- 解析 DNS 后校验**全部**记录，拒绝回环、RFC1918 私网、链路本地、CGNAT、保留/文档/基准测试/组播地址，以及 IPv4-mapped IPv6、NAT64、6to4、Teredo 等特殊 IPv6 地址。
- 连接时通过自定义 `lookup` pin 住已校验 IP，防止校验后 DNS rebinding。
- 手动处理最多 3 跳重定向，每一跳重新校验协议、凭据、端口和目标 IP。
- 设置连接/响应头超时、响应体空闲超时；错误信息不返回底层 socket/TLS 细节。
- 出站防火墙仍是推荐的纵深防御措施。

### P0-3 已修复：全站 Bearer 认证

- 除 `/api/health`（仅 `{ ok: true }`）外，所有 `/api/*` 均要求 `Authorization: Bearer <token>`。
- `AUTH_TOKEN` 至少 16 个可打印非空格字符；未设置时启动时随机生成并打印，不再存在无认证模式。
- 使用 `crypto.timingSafeEqual` 比较令牌；认证失败按 IP 限流（默认 10 次/分钟），返回通用 401。
- 前端增加访问令牌对话框，令牌仅存入 `sessionStorage`；PDF.js 通过 `httpHeaders` 携带令牌。
- 不再使用 Cookie 会话；若未来改为 Cookie，登录接口还必须加入 CSRF token 与 `SameSite`，但状态变更接口的 `Origin`/`Sec-Fetch-Site` 校验已在 P2-3 落地。

### P0-4 已修复：PDF.js 升级与脚本关闭

- `pdfjs-dist` 从 `5.7.284` 升级到 **`6.4.299`**，高于 CVE-2026-16633 / GHSA-hq66-cqwq-w95j 的修复版本 `6.2.108`。
- `package.json` 的 Node 引擎要求改为 `>=22.13.0`。
- 前端 `getDocument()` 显式设置 `enableScripting: false`、`enableXfa: false`。
- 保留严格 CSP；`/content` 响应增加 `Content-Security-Policy: sandbox; default-src 'none'` 与 `Cache-Control: private, no-store`。
- `npm audit --omit=dev` 已无 high/critical 漏洞。

### P0-5 已修复：资源上限与超时

- `MAX_DOCUMENTS`（默认 100）限制全局文档会话数；`MAX_DOCUMENTS_PER_IP`（默认 5）限制单 IP 会话数。
- `MAX_CONCURRENT_STREAMS`（默认 100）限制并发内容流；超限返回 503。
- 创建/内容/删除接口按 IP 限流（默认 10 / 600 / 30 次每分钟）；认证失败单独限流。
- `MAX_REMOTE_BYTES`（默认 2 GiB）限制单次内容响应，覆盖无 Range 完整响应和覆盖整个文件的 Range 请求。
- `REMOTE_HEADERS_TIMEOUT_MS`、`REMOTE_BODY_IDLE_TIMEOUT_MS` 限制上游连接/响应头/响应体空闲时间。
- 文档 TTL 默认缩短到 30 分钟；Node HTTP 服务器设置 `headersTimeout`、`requestTimeout`、`keepAliveTimeout`、`maxConnections`、`maxRequestsPerSocket`。
- 临时镜像已删除，不再存在镜像磁盘残留与镜像总量配额问题。

### P1-1 ~ P1-3 已修复（2026-10-21 第二轮）

#### P1-1 Host 头白名单 / DNS rebinding

- 新增 `server/host.js`：严格解析 `Host` 头（支持 `host:port` 与 `[IPv6]:port`，拒绝重复 Host、无括号 IPv6、非法端口、通配符和 URL 形式）。
- `server/app.js` 在路由和认证之前执行 Host 校验；不匹配返回 **421 Misdirected Request**，缺失 Host 由 Node（HTTP/1.1 返回 400）或 Host 校验（HTTP/1.0 返回 421）拒绝；`/api/health` 和静态资源同样受保护。
- 默认只允许 `localhost`、`127.0.0.1`、`::1`（含任意端口及 IPv4-mapped/展开形式）等回环主机名。
- `ALLOWED_HOSTS` 支持逗号分隔域名（可带端口），与回环主机名共同生效。
- `server/index.js` 在 `HOST` 绑定非回环地址且未配置 `ALLOWED_HOSTS` 时**拒绝启动**，避免“监听 0.0.0.0 但忘记 Host 白名单”的误配置。
- 反向代理仍应配置 `server_name`/Host 白名单，并保持 `proxy_set_header Host $host`，形成纵深防御。

#### P1-2 信息泄露收口

- `publicInfo()` 只返回 UI 必需字段（`id`、`name`、`size`、`contentType`、`source`、`display`、`mirrored`、`rangeSupported`、`contentUrl`）；不再返回 owner IP、上游 URL、绝对路径、ETag、Last-Modified、配额等内部信息。
- 远端错误统一脱敏：不再回显上游 HTTP 状态码、主机名、端口、压缩算法或 socket/TLS 细节；保留 `REMOTE_FORBIDDEN`、`REMOTE_NOT_FOUND` 等语义错误码。
- `display` 只保留 host + pathname（不含 query/fragment/userinfo），并去除控制字符、限制长度。
- 所有 `/api/*` 响应与错误响应设置 `Cache-Control: no-store`，避免元数据/错误被缓存。
- `/api/health` 仍只返回 `{ ok: true }`，`/api/config` 仍只返回 `rangeChunkSize`；不再提供会话计数或 uptime。

#### P1-3 移除 `?path=` / `?url=` / `?open=` 自动打开

- 前端不再读取 `window.location.search`、不使用 `URLSearchParams`，页面加载不会触发任何 `POST /api/documents`。
- 打开文档只允许两种显式用户操作：提交打开表单，或点击“最近打开”条目。
- 新增静态回归测试，禁止 `URLSearchParams`、`location.search`、`autoUrl/autoPath/autoOpen` 及 `get('url'/'path'/'open')` 重新出现在前端代码中。

### 修复后实际配置

| 环境变量 | 实际默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | 建议保持回环，由反向代理接入 |
| `ALLOWED_HOSTS` | 空（仅回环主机名） | 逗号分隔 Host 白名单；非回环绑定必须设置，不匹配返回 421 |
| `AUTH_TOKEN` | 随机生成 | 至少 16 个字符；未设置时启动打印随机值 |
| `MAX_DOCUMENTS` | `100` | 全局文档数上限 |
| `MAX_DOCUMENTS_PER_IP` | `5` | 每 IP 文档数上限 |
| `MAX_REMOTE_BYTES` | `2147483648` | 单次内容响应最大字节数 |
| `DOCUMENT_TTL_MINUTES` | `30` | 文档会话闲置过期时间 |
| `MAX_CONCURRENT_STREAMS` | `100` | 并发内容流上限 |
| `ALLOWED_REMOTE_PORTS` | `80,443` | 允许访问的远端端口 |
| `REMOTE_HEADERS_TIMEOUT_MS` | `20000` | 连接/响应头超时 |
| `REMOTE_BODY_IDLE_TIMEOUT_MS` | `30000` | 响应体空闲超时 |
| `TRUST_PROXY` | 空 | 设为 `1` 时信任一层代理的 `X-Forwarded-For` |
| `ENABLE_HSTS` | 空 | HTTPS 部署时设为 `1` |

本文第 4 节列出的是修复前的建议变量；`PUBLIC_MODE`、`ALLOW_LOCAL_FILES`、`ALLOW_REMOTE_URLS`、`PDF_ALLOWED_ROOTS`、`REMOTE_MIRROR_LIMIT_MB`、`MAX_TOTAL_MIRROR_BYTES` 在当前实现中已不再使用。

### 复核验证结果

- `npm test`：**34 项通过，0 失败**（2026-10-21 复核时；2026-10-22 加固后增至 **67 项**，见下文）。覆盖认证、LFI 拒绝、SSRF 地址/编码/重定向、Range 代理、限流、并发槽释放、上游超时、大小上限、Host 白名单、信息脱敏、安全头、Origin/CSRF、日志脱敏、指标、文件名清洗、临时目录清理、前端无自动打开等。
- `npm audit --omit=dev`：**0 vulnerabilities**。
- 使用 `test-pdf/大辞海：法学卷.pdf`（约 1.1 GB）经本地 Range 测试服务验证：创建文档 201、分片读取 206、`Content-Range` 正确、无认证返回 401、删除 204。
- 使用 PDF.js 6 实际解析该 1.1 GB PDF 成功（868 页）。
- Host 校验动态验证：`Host: evil.example` / 非白名单域名返回 421；`Host: pdf.example.com`、带端口、大小写、回环别名返回 200；重复 Host 与缺失 Host 被拒绝或由 Node 返回 400。
- 未设置 `ALLOWED_HOSTS` 且 `HOST=0.0.0.0` 时进程拒绝启动；设置后正常监听。
- 环境无可用的图形浏览器，未做真实浏览器 GUI 点击回归；前端通过语法检查与静态回归测试，服务端/API 与 PDF.js 解析链路已验证。

### P2/P3 修复复核详情（2026-10-22）

#### P2-1 安全响应头与缓存

- `securityHeaders()` 在原有 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、COOP/CORP、`X-Permitted-Cross-Domain-Policies` 基础上，新增 `X-DNS-Prefetch-Control: off`、`Origin-Agent-Cluster: ?1`，并扩展 `Permissions-Policy`（`accelerometer`、`autoplay`、`browsing-topics`、`camera`、`display-capture`、`geolocation`、`gyroscope`、`interest-cohort`、`magnetometer`、`microphone`、`midi`、`payment`、`usb`）。
- CSP 增加 `manifest-src 'self'`，保留 `form-action 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`，仍无 `'unsafe-eval'` / 脚本 `'unsafe-inline'`。
- `Strict-Transport-Security` 仅在 `ENABLE_HSTS=1` 时发送，避免在明文 HTTP 上误发。
- `/api/*` 与错误响应统一 `Cache-Control: no-store`；`/content` 使用 `private, no-store` 与 `Content-Security-Policy: sandbox; default-src 'none'`。
- 所有响应新增 `X-Request-Id`，便于与代理/SIEM 日志关联。

#### P2-2 PDF 目录链接协议白名单

- `safeOutlineUrl()` 只允许 `http:`、`https:`、`mailto:`；拒绝 `javascript:`、`data:`、`file:`、`blob:` 与自定义协议。
- 额外拒绝 URL 内嵌用户名/密码、空 hostname 与超长（>4096 字符）链接。
- 仍使用 `window.open(target, '_blank', 'noopener,noreferrer')`；解析失败时提示“该书签链接被拒绝”，不执行任何跳转。
- 新增静态回归测试，禁止 `window.open(item.url, ...)` 重新出现。

#### P2-3 CSRF / Origin 防护

- 新增 `server/origin-guard.js`，在 Host 校验之后、路由之前对所有 `/api/*` 状态变更方法（非 GET/HEAD/OPTIONS）执行：
  - `Sec-Fetch-Site: cross-site` 拒绝；未知值拒绝；
  - `Origin` 缺失（curl/服务端调用）放行，但仍需 Bearer 令牌；
  - `Origin: null`、非法协议、带路径/查询/凭据的 Origin 拒绝；
  - Origin 的 hostname 必须与请求 `Host` 一致（端口同时出现时必须一致），或在 `ALLOWED_ORIGINS` 白名单内。
- `ALLOWED_ORIGINS` 仅接受逗号分隔的 `scheme://host[:port]`；通配符、路径、查询、凭据、非 HTTP(S) 协议在启动时报 `ALLOWED_ORIGINS_INVALID`。
- 命中拒绝时返回 `403 CROSS_SITE_REQUEST`，并记录脱敏的 `request.cross_site_blocked` 事件。
- 该防护是纵深防御：当前 Bearer 头不会被浏览器自动附加；若未来切换到 Cookie 会话，CSRF 防线已就位。

#### P2-4 临时镜像残留

- 当前版本本就不落盘（不支持 Range 的远端直接 `422 REMOTE_NO_RANGE`）。
- 新增 `server/temp-cleanup.js`：启动时扫描系统临时目录，只匹配 `^stream-pdf-[A-Za-z0-9]{6}$`、只删除超过 24 小时的**真实目录**（`Dirent.isDirectory()` + `lstat`，不跟随符号链接），失败仅记录告警，不影响启动。
- 优雅退出继续调用 `store.cleanupAll()`；临时目录清理结果写入结构化日志 `temp.cleanup_done`。
- 新增单元测试覆盖旧目录、新目录、无前缀目录、同名文件、符号链接等场景。

#### P2-5 文件名与双向文本加固

- 路径模式已删除，Windows 路径白名单比较问题不再适用。
- 新增 `server/filename.js`，统一清洗远端 `Content-Disposition` 文件名、outline 显示文本与 `Content-Disposition` 响应头：
  - 移除 C0/C1 控制字符与 Unicode 双向覆盖字符（`U+202A–U+202E`、`U+2066–U+2069`、`U+200E/U+200F`）；
  - 替换 `\ / : * ? " < > |` 等文件系统/头部元字符；
  - 限制为 160 个码点，避免超长头部与 UI 欺骗；
  - 空名、纯点号、纯空白回退到“未命名文档.pdf”。
- 新增文件名与显示文本单元测试（含 emoji 多字节截断、RTL 覆盖字符、超长名称）。

#### P3 持续加固

- **日志**：新增 `server/logger.js`，单行 JSON 输出，自动脱敏 `Authorization`/`Cookie`/`token`/`secret`/`password`/`session`/`credential`/`signature` 等键；URL 只保留 `scheme://host/path`（丢弃 userinfo/query/fragment）；引号包裹的绝对路径只保留 basename；移除控制字符与双向覆盖字符；错误只记录 `name`/`code`/`status`/`message`，不记录堆栈。日志写入失败不会影响请求。事件覆盖 `auth.failed`、`document.opened`、`document.open_failed`、`document.deleted`、`rate.limited`、`host.rejected`、`request.cross_site_blocked`、`stream.failed`、`request.error`、`server.shutdown` 等。
- **令牌**：非回环绑定必须显式设置 `AUTH_TOKEN`；交互式终端才打印随机令牌，非交互进程写入 `./.auth-token`（`0600`），写入失败拒绝启动，避免令牌进入 journal/容器日志。
- **监控**：可选 `ENABLE_METRICS=1` 开放需认证的 `GET /api/metrics`，返回文档数、活动/峰值流、请求/4xx/5xx、认证失败、限流、上游失败、已发送字节等聚合值，并带 `Cache-Control: no-store`；默认关闭。另支持 `METRICS_LOG_INTERVAL_MINUTES` 周期性输出 `metrics.snapshot`，供 SIEM 采集。
- **依赖与供应链**：新增 `.github/workflows/security.yml`（Node 22.13/24 矩阵执行 `npm ci`、`npm test`、`npm audit --omit=dev --audit-level=high`，PR 触发 dependency-review）与 `.github/dependabot.yml`（npm + GitHub Actions 每周更新）。
- **部署模板**：新增 `deploy/streampdf.service`（非 root、`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`、空 capability、`SystemCallFilter`、`MemoryMax`/`TasksMax`/`LimitNOFILE`）、`deploy/nginx.conf`（TLS、HSTS、限流、连接数、64k 请求体、`proxy_buffering off`、原始 Host）、`deploy/Dockerfile`（非 root、`npm ci --omit=dev --ignore-scripts`、healthcheck）与 `deploy/docker-compose.yml`（`read_only`、`tmpfs`、`cap_drop ALL`、`no-new-privileges`、pids/memory/cpu 限制、仅绑定回环）。
- **文档与仓库卫生**：新增 `SECURITY.md`（威胁模型、支持版本、漏洞上报、公网部署清单）；`.gitignore` 增加 `.env`、`.env.*`、`*.pem`、`*.key`、`*.crt`、`*.p12`、`*.pfx`、`.auth-token`；新增 `.dockerignore` 防止构建上下文带入密钥与测试数据。

#### 新增/调整的环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的允许跨源前端源；默认仅同源 |
| `ENABLE_METRICS` | 空 | `1` 时开放认证的 `GET /api/metrics` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `METRICS_LOG_INTERVAL_MINUTES` | `15` | 指标快照日志间隔，`0` 关闭 |

#### 验证结果（2026-10-22）

- `npm test`：**67 项通过，0 失败**。新增覆盖：安全头、HSTS 开关、跨站 Origin/Sec-Fetch-Site、`ALLOWED_ORIGINS`、指标接口、日志脱敏、文件名/双向文本、临时目录清理、CI/部署模板/`.gitignore` 静态检查。
- `npm audit --omit=dev`：**0 vulnerabilities**。
- 动态验证：同源 `Origin` 通过、`evil.example` / `Origin: null` / 跨站 `Sec-Fetch-Site` 返回 `403 CROSS_SITE_REQUEST`；配置 `ALLOWED_ORIGINS` 后对应源通过；`/api/metrics` 默认 404、开启后未认证 401、认证后 200 且 `no-store`；非白名单 Host 仍返回 421；日志中未出现 Authorization/token/URL query/绝对路径。
- 未在真实图形浏览器中做点击回归（环境限制）；前端通过语法检查与静态回归测试，服务端/API 已实测。

### 复核后仍待处理

- 部署层仍应完成：反向代理 `server_name`/Host 白名单、TLS 与 HSTS、出站防火墙（阻断到 RFC1918、`169.254.0.0/16` 和本机）、主机/容器资源限制、SIEM/告警接入。模板见 `deploy/` 与 `SECURITY.md`。
- 应用层 Host 白名单与 Origin 校验用于纵深防御，不替代代理配置；代理必须传递原始 `Host`。
- 若未来改用 Cookie 会话，需同时在登录接口加入 CSRF token、`SameSite=Strict`、登录限速；现有 Origin 防护已覆盖大部分场景。


---

## 2. 关键发现详情

### P0-1 未认证任意本地 PDF 读取（LFI）

> **修复状态（2026-10-21）**：**已修复**。本地路径模式、`PDF_ALLOWED_ROOTS`、服务端文件读取与临时镜像均已删除；详见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。以下为修复前的发现问题与建议，保留作历史记录。

**位置**

- `server/sources.js:44-72` `inspectLocalSource()`
- `server/sources.js:471-490` `assertAllowedRoot()`
- `server/app.js:54-68` `POST /api/documents`
- `server/documents.js:86-102` `publicInfo()`（回显绝对路径）

**问题**

`POST /api/documents` 接受任意 `{"source":"path","value":"..."}`。`inspectLocalSource()` 只检查目标是否是普通文件、是否以 `%PDF-` 开头，然后就把路径交给 `createReadStream()`。

`assertAllowedRoot()` 的关键缺陷是 **fail-open**：

```js
const configured = (process.env.PDF_ALLOWED_ROOTS || '')
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(expandHome(entry)));

if (configured.length === 0) {
  return; // ← 未配置 = 允许读取任意路径
}
```

也就是说，一旦按 README 将 `HOST` 改为 `0.0.0.0` 或通过反向代理暴露（也就是本报告要解决的场景），**任何能访问该端口的人都可以读取服务器上任意 PDF**，包括 `/home`、`/srv`、挂载的网盘、备份目录中的合同/发票/证件扫描件等。`%PDF-` 检查只排除了非 PDF，不构成访问控制。

同时，`publicInfo()` 把 `doc.path` 原样作为 `location` 返回，等于把服务器绝对路径主动告诉调用方。

**动态验证（本机回环实例）**

```text
POST /api/documents
{"source":"path","value":"/mnt/h/书/AttentionIsAllYouNeed.pdf"}
→ 201
{
  "name": "AttentionIsAllYouNeed.pdf",
  "size": 2215244,
  "location": "/mnt/h/书/AttentionIsAllYouNeed.pdf"
}

GET /api/documents/<id>/content
Range: bytes=0-7
→ 206 "%PDF-1.5"
```

项目目录之外的 PDF 被成功打开并读取字节。

文件存在性探测（非 PDF 文件也会被打开并读取前 5 字节）：

```text
POST {"source":"path","value":"/etc/passwd"}
→ 422 NOT_PDF            # 文件存在且可读

POST {"source":"path","value":"/root/definitely-missing-xyz.pdf"}
→ 400 PATH_UNREADABLE
  "EACCES: permission denied, realpath '/root/definitely-missing-xyz.pdf'"
```

错误码和错误消息可以区分“存在/不存在/无权限”，并且把绝对路径回显给调用方。

**影响**

- 未认证读取服务器上任意 PDF（合同、报表、扫描件、导出数据等）。
- 枚举任意文件是否存在、是否可读。
- 泄露服务器目录结构、挂载点、运行用户信息。
- 若与 P1-3 自动打开参数、DNS rebinding 或 XSS 组合，可实现“受害者浏览器触发 + 攻击者读取响应”。

**修复建议**

1. **改为 fail-closed**：`PDF_ALLOWED_ROOTS` 为空时拒绝路径读取，而不是放行。

```js
function assertAllowedRoot(realPath) {
  const configured = (process.env.PDF_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandHome(entry)));

  if (configured.length === 0) {
    throw new HttpError(
      403,
      'LOCAL_FILES_DISABLED',
      '本地文件读取未启用。',
      '管理员需配置 PDF_ALLOWED_ROOTS。',
    );
  }

  const allowed = configured.some((root) => {
    const rel = path.relative(root, realPath);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });

  if (!allowed) {
    throw new HttpError(403, 'PATH_OUTSIDE_ALLOWED_ROOTS', '该路径不在允许的目录内。');
  }
}
```

2. **启动时强制校验**：如果 `HOST` 不是回环地址，而 `PDF_ALLOWED_ROOTS` 或认证未配置，直接拒绝启动（见 P0-3 的 `server/index.js` 示例）。

3. **公网模式默认禁用路径读取**：新增 `PUBLIC_MODE=1`，此时 `ALLOW_LOCAL_FILES=0`，只允许管理员预置的目录/文档；或干脆只提供 URL 模式（并同时修好 SSRF）。

4. **不要把绝对路径返回给客户端**：

```js
location: doc.kind === 'local' ? path.basename(doc.path) : doc.display,
```

5. **错误消息脱敏**：客户端只返回“无法读取该文件/路径不存在”，详细 `error.code`、`errno`、路径写入服务端日志。

6. **防御性打开**：`realpath` 之后尽量用 `O_NOFOLLOW` 打开最终文件，并对 `fstat` 结果再次校验；在共享主机上降低 TOCTOU 风险。

7. **权限最小化**：进程运行用户只对允许目录有读权限；不要把 `/home`、`/root`、Docker socket、云盘凭据目录暴露给进程。

**验证方法**

- `PDF_ALLOWED_ROOTS` 未设置时，`/etc/passwd` 应返回 403，而不是 422/400。
- 设置 `PDF_ALLOWED_ROOTS=/srv/pdfs` 后，`/etc/passwd` 返回 403，`/srv/pdfs/a.pdf` 返回 201。
- 符号链接指向根目录外时返回 403。
- 响应中不再出现服务器绝对路径。

> 备注：本机验证时设置 `PDF_ALLOWED_ROOTS=/mnt/h/书` 后，`/etc/passwd` 返回 403，`/mnt/h/书/AttentionIsAllYouNeed.pdf` 返回 201，说明现有校验逻辑在**配置后**是有效的；问题在于默认不配置。

---

### P0-2 未认证 SSRF（服务端请求伪造）

> **修复状态（2026-10-21）**：**已修复**。远端请求统一经过公网 IP 校验、DNS pinning 和逐跳重定向校验；详见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。以下为修复前的发现问题与建议。

**位置**

- `server/sources.js:120-207` `inspectRemoteSource()`
- `server/sources.js:266-313` `fetchRemoteBody()`
- `server/sources.js:330-341` `parseHttpUrl()`（只校验协议）
- `server/app.js:54-68` 入口

**问题**

服务端接受任意 `http://` / `https://` URL，并使用全局 `fetch()` 请求，`redirect: 'follow'`。没有目标主机白名单、没有私网/回环/链路本地地址过滤、没有 DNS pinning、没有逐跳重定向校验。

因此可访问：

- `127.0.0.1` / `localhost` / `[::1]`（本机管理面板、其他 Node 服务、数据库 HTTP 接口）
- `10/8`、`172.16/12`、`192.168/16`（内网）
- `169.254.0.0/16`（链路本地、云元数据）
- 云厂商元数据地址（`169.254.169.254`、阿里云 `100.100.100.200` 等）
- 通过 `http://2130706433/`、`http://0x7f000001/`、IPv4-mapped IPv6 等编码绕过简单字符串黑名单（WHATWG URL 会规范化，但仍需在连接层校验）
- 通过 DNS rebinding 把“合法域名”解析到内网地址
- 通过 302 重定向跳到内网（`redirect: 'follow'` 不会重新校验）

**动态验证**

启动一个只监听 `127.0.0.1` 的“内部服务”，返回带 `%PDF-` 的内容：

```text
POST /api/documents
{"source":"url","value":"http://127.0.0.1:36287/internal-secret.pdf"}
→ 201
{
  "display": "127.0.0.1:36287/internal-secret.pdf",
  "contentUrl": "/api/documents/<id>/content"
}

GET /api/documents/<id>/content
Range: bytes=0-15
→ 206 "%PDF-1.7\n1 0 obj"
```

服务端成功访问了回环地址上的内部服务，并读取了内容。

端口探测/网络测绘：

```text
POST {"source":"url","value":"http://127.0.0.1:1/x.pdf"}
→ 502 REMOTE_UNREACHABLE "fetch failed"
```

不同错误码（`REMOTE_UNREACHABLE` / `REMOTE_TIMEOUT` / `REMOTE_NOT_PDF` / `REMOTE_HTTP_ERROR`）和响应耗时，足以区分“端口开放/关闭/超时/返回非 PDF”。

**影响**

- 读取内网/本机上的 PDF 文件或对象存储内容。
- 扫描内网主机、端口、服务。
- 对内部 GET 接口发起请求（还会带上 `Range` 头），可能触发内部状态变更（如果内部接口违反 GET 幂等原则）。
- 结合 DNS rebinding 绕过基于域名的白名单。
- 结合 P0-1 的 `?url=` 自动打开，可让受害者浏览器触发服务端对内网的请求。

**修复建议**

1. **公网模式默认禁用远程 URL**：`ALLOW_REMOTE_URLS=0`；需要时由管理员配置域名/端口白名单（例如只允许 `*.cdn.example.com:443`）。

2. **解析并校验目标 IP**，拒绝所有非公网地址。至少覆盖：

```text
IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
      169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
      192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
      203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4
IPv6: ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8,
      ::ffff:0:0/96（IPv4-mapped，需拆出 IPv4 再判断）,
      64:ff9b::/96（NAT64）, 2002::/16（6to4）, 2001::/32（Teredo）
```

3. **在连接层 pin 住已校验的 IP**，防 DNS rebinding。不要“先 `dns.lookup` 校验、再让 `fetch` 自己解析”。Node 内置 `fetch` 基于 undici，但要让自定义 `lookup` 生效，建议新增 `undici` 依赖并使用它导出的 `fetch` + `Agent`（保证 `Agent` 与 `fetch` 来自同一实例）；或者改用 `http/https.request` 的 `lookup` 选项。下面中 `isPublicAddress()` 需自行实现（可用 `net.BlockList` 或 `ipaddr.js` 按 P0-2 第 2 条的网段判断）：

```js
import { Agent, fetch as undiciFetch } from 'undici';
import dns from 'node:dns';
import net from 'node:net';

const safeAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
        for (const { address } of list) {
          if (!isPublicAddress(address)) {
            return callback(new Error('blocked non-public address'));
          }
        }
        // 只返回已校验地址，确保后续连接不会再解析
        const first = list[0];
        callback(null, first.address, first.family);
      });
    },
  },
});

const response = await undiciFetch(url, {
  dispatcher: safeAgent,
  redirect: 'manual', // 自己处理重定向
  signal: AbortSignal.timeout(15_000),
});
```

4. **手动处理重定向**：最多 3 跳，每一跳都重新解析、校验协议/主机/IP，禁止 `http -> file` 等协议变化。

5. **端口限制**：默认只允许 `80/443`；需要其他端口时显式白名单。

6. **禁止 URL userinfo**：`http://user:pass@host/` 直接拒绝，避免凭据被带入日志/上游。

7. **出站防火墙**：在容器/主机层只允许到白名单 CDN 的 443，阻断到 RFC1918、`169.254.169.254`、本机的出站流量。应用层校验可能被零日绕过，网络层是最后一道防线。

8. **限制响应大小与时间**：见 P0-5。

9. **错误消息脱敏**：对公网只返回“远端不可达/目标不允许”，不要把内网主机名、状态码、`error.message` 原样返回。

10. **考虑直接移除远程 URL 功能**：如果公网部署的核心诉求是“预览服务器本地 PDF”，远程代理是最大攻击面，移除最安全。

**验证方法**

- `http://127.0.0.1:...`、`http://localhost:...`、`http://[::1]:...` 返回 400/403。
- `http://169.254.169.254/latest/meta-data/` 返回 400/403，且不产生实际连接（用 mock DNS/连接计数验证）。
- `http://10.0.0.1/`、`http://192.168.1.1/`、`http://2130706433/`、`http://0x7f000001/` 均被拒绝。
- 从公网 URL 302 到 `http://127.0.0.1/` 被拒绝。
- 自定义域名解析到 `127.0.0.1` 被拒绝。
- 正常公网 PDF 仍可打开。

---

### P0-3 全站无认证/授权

> **修复状态（2026-10-21）**：**已修复**。除 `/api/health` 外所有 `/api/*` 均要求 Bearer 令牌；详见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。以下为修复前的发现问题与建议。

**位置**

- `server/app.js:36-114` 全部 `/api/*`
- `server/app.js:116-139` 静态资源（可公开，但 UI 也暴露）
- `server/index.js:4` 默认 `HOST=127.0.0.1`（默认安全，但改 `0.0.0.0` 后无任何门禁）

**问题**

没有任何认证、会话、API Key、IP 白名单或授权。任何能建立 TCP 连接的人都可以：

- `POST /api/documents`：创建任意本地/远程文档会话（触发 P0-1/P0-2）。
- `GET /api/documents/:id/content`：读取内容（ID 是 UUIDv4，但创建接口开放，攻击者可创建自己的；若 ID 从日志/历史/Referer 泄露，则可读他人文档）。
- `GET /api/documents/:id/stats`：读取统计。
- `DELETE /api/documents/:id`：删除会话（若 ID 已知，任意人可删）。
- `GET /api/health`：读取文档数、uptime。
- `GET /api/config`：读取限制值。

UUIDv4 不可猜测只能算“能力令牌（capability token）”，不是认证。文档 ID 会出现在浏览器历史、服务端访问日志、代理日志、错误上报中；一旦泄露，持有者即可读取对应 PDF。多用户场景下也没有“文档属于谁”的概念。

**影响**

- 公网部署即“开放代理 + 开放文件读取器”。
- 无法审计“谁读了什么”。
- 无法做配额、封禁、滥用处置。
- 删除接口可被用于破坏他人会话（若 ID 泄露）。

**修复建议**

推荐 **把认证放在反向代理层**，应用只监听回环：

```text
Internet
  → CDN / WAF（TLS、限速、Bot 防护）
  → nginx / Caddy（TLS 终止、auth_request）
  → OAuth2-proxy / Authentik / Authelia / Cloudflare Access（身份认证）
  → StreamPDF 127.0.0.1:3000（应用层再做一次 token 校验）
```

应用层至少加一个共享令牌/会话校验，作为“纵深防御”：

```js
import { timingSafeEqual } from 'node:crypto';

function requireAuth(req, res, next) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: { code: 'AUTH_NOT_CONFIGURED', message: '服务未配置认证。', hint: null },
    });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: '未认证。', hint: null },
    });
  }
  next();
}

// 健康检查放在认证之前，只返回最小信息（若不需要公网健康检查，可一并保护）
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', requireAuth);
```

如果使用 Cookie 会话：

- `HttpOnly; Secure; SameSite=Strict`。
- 登录接口限速、失败锁定。
- CSRF token + `Origin`/`Sec-Fetch-Site` 校验（见 P2-3）。
- 退出登录时清理服务端会话与浏览器缓存中的文档。

**多用户/多租户**：

- 文档记录增加 `ownerId`；`require()` 时校验 `doc.ownerId === req.user.id`。
- `DELETE` 只允许 owner。
- 配额按用户/租户计算。
- 审计日志记录 `user`、`docId`、`source`、`bytes`、`ip`、`ua`，并对 URL/路径脱敏。

**最小可行公网方案（单用户）**：

- 反向代理 Basic Auth 或 OAuth2-proxy。
- 应用只监听 `127.0.0.1`。
- `PDF_ALLOWED_ROOTS` 指向只读挂载的 PDF 目录。
- 关闭远程 URL 或仅允许白名单。
- 限速、配额、超时、日志。

**验证方法**

- 未带凭证访问所有 `/api/*` 返回 401。
- 错误 token 返回 401，且不泄露“token 是否存在”。
- 带正确 token 可正常打开文档。
- `DELETE` 只能删除自己的文档。
- 反向代理层直接访问 Node 端口应不可达（只绑回环/防火墙）。

---

### P0-4 `pdfjs-dist@5.7.284` 高危漏洞

> **修复状态（2026-10-21）**：**已修复**。已升级到 `pdfjs-dist@6.4.299`，并显式关闭脚本/XFA；详见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。以下为修复前的发现问题与建议。

**位置**

- `package.json`：`"pdfjs-dist": "^5.7.284"`
- 实际安装：`node_modules/pdfjs-dist/package.json` → `5.7.284`

**`npm audit --omit=dev` 结果**

```text
pdfjs-dist
Severity: high
PDF.js: Arbitrary JavaScript execution upon opening a malicious PDF
https://github.com/advisories/GHSA-hq66-cqwq-w95j
No fix available
node_modules/pdfjs-dist

1 high severity vulnerability
```

**漏洞详情**

- **GHSA-hq66-cqwq-w95j / CVE-2026-16633**
- 类型：CWE-79（跨站脚本/任意 JavaScript 执行）
- CVSS v4：8.6（`AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:N`）
- 影响版本：`>=5.6.83 <6.2.108`
- 修复版本：`6.2.108+`；当前 npm 最新为 `6.4.299`（要求 Node `>=22.13.0 || >=24`）。`npm audit` 显示 `No fix available` 是因为 5.x 线没有非破坏性修复，不是没有修复版本；需要跨大版本升级。
- **注意**：6.x 要求 Node `>=22.13.0`。如果必须停留在 Node 20，则没有已修复的 5.x 版本，需要先升级 Node 运行时，或明确接受该风险并限制 PDF 来源。
- 触发条件：PDF.js 以 `enableScripting: true` 加载恶意 PDF，且页面 CSP 未限制 `script-src` 时，PDF 内脚本可在宿主域名上下文执行。

**本项目当前缓解措施（已核实）**

- `public/js/app.js:91-100` 构造 `PDFViewer` 时没有传入 `scriptingManager`；`pdf_viewer.mjs` 中 `enableScripting` getter 返回 `!!this._scriptingManager`，因此为 `false`。
- `public/js/app.js:656-667` 调用 `getDocument()` 时没有传 `enableScripting`；`pdf.mjs` 中只有 `enableScripting === true` 才启用，默认 `false`。
- `server/app.js:331-353` 的 CSP 为 `script-src 'self' 'wasm-unsafe-eval'`，没有 `'unsafe-inline'` / `'unsafe-eval'`，可阻断内联脚本与 `eval`。

因此该 CVE 的**特定利用链在当前代码中大概率不可达**，但这是“依赖 + 配置”的巧合，不应作为长期依赖：

- 后续若有人为了支持 PDF 表单脚本而加 `PDFScriptingManager`，风险立即恢复。
- PDF.js 解析器仍有其他历史漏洞/未来漏洞；公网会加载不可信 PDF。
- `npm audit` 会在 CI/合规扫描中持续报高危。

**修复建议**

1. **升级到 `pdfjs-dist@^6.4.299`**（或至少 `>=6.2.108`），并同步调整 Node 引擎要求：

```json
{
  "engines": { "node": ">=22.13.0" },
  "dependencies": {
    "pdfjs-dist": "^6.4.299"
  }
}
```

已确认 `6.4.299` 仍保留本项目使用的资源路径：

```text
build/pdf.mjs
build/pdf.worker.mjs
web/pdf_viewer.mjs
web/pdf_viewer.css
cmaps/ standard_fonts/ wasm/ iccs/
```

2. 升级后运行 `npm test`，并在浏览器中回归：打开、翻页、缩放、目录、加密 PDF、XFA、表单、移动端。
3. **显式关闭脚本**，不要依赖默认值：

```js
const loadingTask = pdfjsLib.getDocument({
  // ...
  enableScripting: false,
  enableXfa: false,
});
```

4. **保留并加强 CSP**，见 P2-1；考虑给 `/content` 响应加 `Content-Security-Policy: sandbox; default-src 'none'`，即使被直接导航也不执行 PDF 内脚本。
5. 若短期无法升级：
   - 明确设置 `enableScripting: false`；
   - 只允许可信 PDF 来源；
   - 在隔离域名/沙箱 iframe 中渲染 PDF（与 API 不同源），降低 XSS 后直接调用同源 API 的风险；
   - 在 `SECURITY.md` 中登记为已知例外并设定升级期限。

**验证方法**

- `npm audit --omit=dev` 无 high/critical。
- 用 EICAR 式的恶意 PDF 测试样本（仅测试环境）打开，确认无脚本执行、无同源 API 调用。
- `grep -R "enableScripting" public/` 确认显式为 `false`。

---

### P0-5 资源耗尽 / 拒绝服务

> **修复状态（2026-10-21）**：**已修复**。已增加文档数、每 IP 配额、并发流、上游超时、响应大小和速率限制，并移除临时镜像；详见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。以下为修复前的发现问题与建议。

**位置**

- `server/documents.js:10-16`：`DocumentStore` 无最大文档数；每 10 分钟清理一次，TTL 12 小时。
- `server/documents.js:18-44`：每次 `open()` 都新增 Map 条目。
- `server/sources.js:209-264`：每个不支持 Range 的远程文档最多镜像 `REMOTE_MIRROR_LIMIT_MB`（默认 64 MB）到 `/tmp`。
- `server/sources.js:266-313`：`fetchRemoteBody()` 没有超时，只依赖客户端断开时的 `AbortController`。
- `server/app.js:87-114`：`/content` 无并发/速率限制。
- `server/index.js:55-58`：`REMOTE_MIRROR_LIMIT_MB` 只要求正整数，无上限。

**问题与放大路径**

1. **文档数无上限**：攻击者循环 `POST /api/documents`，每次创建一个 Map 条目（12 小时 TTL），内存持续增长；`/api/health` 会显示 `documents` 计数。
2. **磁盘镜像无总量上限**：每个远程 200 响应的小文件最多 64 MB；100 个请求就是 6.4 GB；`REMOTE_MIRROR_LIMIT_MB` 还能被配置成 10240（10 GB）。
3. **无速率限制/认证**：以上都可以未认证重复执行。
4. **上游无超时**：`fetchRemoteBody()` 只传客户端 `signal`；攻击者选择一个“慢慢吐字节”的远端，服务端 socket/内存会被长时间占用；客户端不主动断开时可持续数分钟/数小时。
5. **无 Range 的整文件转发无上限**：客户端对 `/content` 发不带 `Range` 的请求时，`fetchRemoteBody()` 以 `start: null` 请求远端 200 响应，并把整个远端文件流给客户端；攻击者可让服务器反复下载数 GB 远端文件（带宽放大）。
6. **并发无上限**：Node 默认不限制连接数/并发流；慢客户端（slowloris/慢读）会长期占用文件描述符和上游连接。
7. **`?path=` 自动打开**：见 P1-3，可被批量触发。

**修复建议**

1. **认证 + 速率限制**（P0-3）。对 `POST /api/documents` 建议每 IP 每分钟 5–10 次；`/content` 每分钟 60–120 次；`DELETE` 每分钟 10 次。
2. **硬上限**：

```js
const MAX_DOCUMENTS = Number(process.env.MAX_DOCUMENTS || 100);
const MAX_DOCUMENTS_PER_IP = Number(process.env.MAX_DOCUMENTS_PER_IP || 5);
const MAX_TOTAL_MIRROR_BYTES = Number(process.env.MAX_TOTAL_MIRROR_BYTES || 256 * 1024 * 1024);
const MAX_REMOTE_BYTES = Number(process.env.MAX_REMOTE_BYTES || 2 * 1024 * 1024 * 1024);
```

在 `DocumentStore.open()` 前检查 `this.docs.size`，按 IP 计数；镜像前检查累计镜像字节，超出返回 429/507。

3. **上游超时与大小限制**：

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000); // 连接/首包
// 数据流动时重置 idle timer，或使用 undici 的 headersTimeout/bodyTimeout
```

对无 Range 的整文件转发设置 `MAX_REMOTE_BYTES`，超过即中止并返回 413；或强制要求远端支持 Range，否则只允许镜像到上限。

4. **Node/HTTP 服务器超时**：

```js
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = 200;          // 视容量调整
server.maxRequestsPerSocket = 100;
server.timeout = 120_000;             // 空闲 socket
```

注意 `requestTimeout` 管的是“接收请求”的时间，不替代响应流空闲超时；慢读客户端需要 `server.timeout` 或反向代理的 `proxy_read_timeout`。

5. **磁盘配额**：把镜像目录放到独立 `tmpfs` 或带 quota 的卷；容器设置 `--tmpfs /tmp:size=512m`；定期扫描并清理 `stream-pdf-*` 残留。
6. **反向代理限流**：nginx `limit_req` / `limit_conn`，Caddy `rate_limit`，Cloudflare Rate Limiting。
7. **监控告警**：文档数、`/tmp` 使用量、活动连接数、上游失败率、5xx 比例。

**验证方法**

- 未认证连续 `POST /api/documents` 超过阈值返回 429。
- 创建超过 `MAX_DOCUMENTS` 返回 503。
- 镜像总量超过 `MAX_TOTAL_MIRROR_BYTES` 返回 507/429。
- 慢速上游在配置的超时后断开。
- 无 Range 的大文件请求被上限中止。
- `/tmp` 无 `stream-pdf-*` 残留（正常关闭/崩溃恢复后）。

---

### P1-1 `Host` 头未校验 / DNS rebinding

> **修复状态（2026-10-21 第二轮）**：**已修复**。新增 `server/host.js` Host 白名单中间件，不匹配返回 421；非回环绑定强制要求 `ALLOWED_HOSTS`，否则拒绝启动。详见 [P1-1 ~ P1-3 已修复](#p1-1--p1-3-已修复2026-10-21-第二轮)。以下为修复前的问题与建议，保留作历史记录。

**位置（修复前）**

- `server/app.js:31-34`：`express()` 初始化，没有 Host 校验中间件。
- `server/index.js:4`：默认绑定 `127.0.0.1`。

**问题**

服务端不校验 `Host`。动态验证：

```text
GET /api/health
Host: attacker.example:3000
→ 200 {"ok":true,...}
```

虽然默认只监听回环，但浏览器可以发起 DNS rebinding：

1. 攻击者让受害者访问 `http://evil.example:3000/`（攻击者服务器，TTL 0）。
2. 页面 JS 稍后再次请求 `http://evil.example:3000/api/...`。
3. DNS 重新解析到 `127.0.0.1`，浏览器认为仍是 `evil.example:3000` 同源，于是可以读取响应。
4. StreamPDF 不校验 Host，照常处理 → 攻击者可在受害者浏览器上下文读取本地 PDF/触发 SSRF。

这也是公网部署时 Host 头注入/缓存投毒的基础。

**修复建议**

1. **绑定回环 + 反向代理**：应用只监听 `127.0.0.1`，公网入口由 nginx/Caddy 处理，并在代理层配置 `server_name`。
2. **应用层 Host 白名单**：

```js
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

app.use((req, res, next) => {
  if (allowedHosts.size === 0) return next(); // 仅开发模式；公网必须配置
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!allowedHosts.has(host)) {
    return res.status(421).type('text/plain').send('Misdirected Request');
  }
  next();
});
```

3. 如果确实在代理后，正确设置 `app.set('trust proxy', 1)`，并且只信任代理传来的 `X-Forwarded-*`；不要无条件信任客户端头。
4. 公网模式强制 `ALLOWED_HOSTS` 非空，启动时校验。

**验证方法**

- `curl -H 'Host: evil.example' http://127.0.0.1:3000/api/health` 返回 421。
- 正确 Host 返回 200。
- DNS rebinding 演练（测试环境）无法读取响应。

---

### P1-2 信息泄露

> **修复状态（2026-10-21 第二轮）**：**已修复**。文档元数据最小化，远端错误不回显状态码/主机/端口/压缩算法，API 与错误响应统一 `no-store`；绝对路径、文档数、uptime 已不再返回。详见 [P1-1 ~ P1-3 已修复](#p1-1--p1-3-已修复2026-10-21-第二轮)。以下为修复前的问题与建议，保留作历史记录。

**位置与内容（修复前）**

| 位置 | 泄露内容 |
| --- | --- |
| `server/documents.js:86-102` | `publicInfo.location` 返回本地文件绝对路径；`etag` 含 size/mtime |
| `server/sources.js:60` | `PATH_UNREADABLE` 返回 `error.message`（含路径、errno） |
| `server/sources.js:54-58` | `PATH_NOT_FOUND` 返回 `resolved` 绝对路径 |
| `server/sources.js:492-523` | 远端错误返回内网主机、HTTP 状态、`error.message` |
| `server/app.js:36-42` | `/api/health` 返回文档数、uptime |
| `server/app.js:44-52` | `/api/config` 返回 `remoteMirrorLimit` 等限制值 |
| `server/app.js:176` | 未处理错误打印完整堆栈到日志（日志本身应保护） |

**影响**

- 泄露服务器目录结构、用户名、挂载点、文件时间/大小。
- 辅助 LFI/SSRF 的路径/主机枚举。
- 暴露服务规模、运行时长、配置，便于攻击者选择策略。

**修复建议**

- `publicInfo` 只返回展示所需信息：`name`、`size`、`contentType`、`source`、`mirrored`、`contentUrl`；不要返回 `location` 绝对路径。
- 客户端错误统一为泛化文案；详细错误写入服务端结构化日志（含 `requestId`）。
- `/api/health` 公网只返回 `{ ok: true }`；如需监控，放在内网或加认证。
- `/api/config` 只返回前端必需字段（`rangeChunkSize`），不要返回限制值。
- 日志脱敏：URL 去掉 query/fragment/userinfo；本地路径只保留 basename 或 hash；不要记录 `Authorization`/Cookie。
- 对 `etag`/`lastModified` 的暴露做评估；敏感场景可去掉 `Last-Modified`。

**验证方法**

- 响应 JSON 中不再出现 `/mnt/`、`/home/`、`/root/`、`/srv/` 等绝对路径。
- 不存在的路径与无权限路径返回相同状态/文案（或至少不泄露路径）。
- `/api/health` 不含文档数/uptime（公网）。

---

### P1-3 `?path=` / `?url=` / `?open=` 自动打开

> **修复状态（2026-10-21 第二轮）**：**已修复**。前端不读取查询字符串，页面加载不会触发 `POST /api/documents`；并加入静态回归测试防止重新引入。详见 [P1-1 ~ P1-3 已修复](#p1-1--p1-3-已修复2026-10-21-第二轮)。以下为修复前的问题与建议，保留作历史记录。

**位置（修复前）**

- `public/js/app.js:112-123`

```js
const params = new URLSearchParams(window.location.search);
const autoUrl = params.get('url');
const autoPath = params.get('path') || params.get('file');
const autoOpen = params.get('open');
if (autoUrl) {
  window.setTimeout(() => openDocument('url', autoUrl), 0);
} else if (autoPath) {
  window.setTimeout(() => openDocument('path', autoPath), 0);
} else if (autoOpen) {
  const source = /^https?:\/\//i.test(autoOpen) ? 'url' : 'path';
  window.setTimeout(() => openDocument(source, autoOpen), 0);
}
```

**问题**

页面加载即触发 `POST /api/documents`，服务端随即读取本地路径或请求远程 URL。一个链接即可让访问者触发：

- 本地 PDF 读取（受害者浏览器看不到内容，但请求已发生；配合 DNS rebinding/XSS 可读取响应）。
- 对内网/本机的 SSRF。
- 填充服务端文档存储（DoS）。
- 把攻击者 URL 写入受害者 `localStorage` 的“最近打开”。

此外，这类 GET 触发的服务端副作用不利于缓存、审计和 CSRF 防护。

**修复建议**

1. **公网模式禁用自动打开**；只保留用户点击/提交后打开。
2. 如必须支持深链，使用**一次性签名 token**，并让用户确认；不要直接接受任意 `path`/`url`。
3. 把打开动作改为 `POST`（前端本来就是 `POST /api/documents`），不要用 GET 参数驱动。
4. 至少加 `PUBLIC_MODE` 条件：

```js
const allowAutoOpen = state.config.allowAutoOpen === true; // 默认 false
if (allowAutoOpen && autoUrl) { ... }
```

**验证方法**

- `/?path=/etc/passwd` 打开页面后，服务端没有收到 `POST /api/documents`。
- `/?url=http://127.0.0.1:...` 不触发服务端请求。
- 正常“打开文档”按钮不受影响。

---

### P2-1 安全响应头不完整；敏感内容可缓存

> **修复状态（2026-10-22 复核）**：**已修复**。安全头已补齐，`/content` 使用 `no-store` + sandbox CSP；详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始发现问题与建议。

**位置**

- `server/app.js:309-319` `contentHeaders()`
- `server/app.js:321-329` `buildContentDisposition()`
- `server/app.js:331-353` `securityHeaders()`

**现状（动态验证）**

```text
content-security-policy: default-src 'self'; base-uri 'none'; object-src 'none';
  frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:;
  media-src 'self' blob:; frame-src 'self' blob:
referrer-policy: no-referrer
x-content-type-options: nosniff
x-frame-options: DENY
```

已有控制不错，但缺少：

- `Strict-Transport-Security`（HTTPS 时）
- `Permissions-Policy`
- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Resource-Policy`
- `X-Permitted-Cross-Domain-Policies`
- `Content-Security-Policy` 的 `form-action`
- `/content` 的 `Content-Security-Policy: sandbox`（直接导航 PDF 时）
- 敏感 PDF 的 `Cache-Control: no-store`（当前 `private, max-age=3600, immutable`）

**风险**

- 缺少 HSTS：TLS 降级/首请求劫持。
- 缺少 COOP/CORP：跨窗口/跨源资源读取面更大。
- `immutable` + 1 小时缓存：用户“关闭/删除”文档后，PDF 仍留在浏览器缓存；共享设备上可被恢复。
- 直接打开 `/content` 时，浏览器原生 PDF 查看器可能执行 PDF 内脚本（取决于浏览器），`sandbox` CSP 可降低风险。

**修复建议**

```js
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (process.env.ENABLE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", // 前端使用 element.style，保留
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "form-action 'self'",
  ].join('; '));
  next();
}
```

`contentHeaders()`：

```js
'Cache-Control': 'private, no-store', // 敏感文档；或 max-age=60
'Content-Security-Policy': "sandbox; default-src 'none'",
'Cross-Origin-Resource-Policy': 'same-origin',
```

> 注意：`Content-Security-Policy: sandbox` 加在 `/content` 响应上，针对“直接导航到该 URL”的场景；PDF.js 通过 fetch/XHR 读取子资源时，响应 CSP 不作用于页面上下文，正常预览不受影响。上线前请用 Chrome/Firefox/Safari 各测一次直接打开与 PDF.js 预览。

**验证方法**

- `curl -I` 检查头齐全。
- 直接打开 `/api/documents/:id/content`，PDF 内脚本不执行（测试样本）。
- 关闭文档后，浏览器缓存中不再保留可离线打开的 PDF（开发者工具确认）。
- HTTPS 下 `curl -I https://...` 有 HSTS。

---

### P2-2 PDF 目录项 URL 未校验协议

> **修复状态（2026-10-22 复核）**：**已修复**。outline URL 仅允许 `http:` / `https:` / `mailto:`，并拒绝内嵌凭据；详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始发现问题与建议。

**位置**

- `public/js/app.js:804-824`

```js
if (item.url) {
  window.open(item.url, '_blank', 'noopener,noreferrer');
}
```

**问题**

`item.url` 来自 PDF 的 outline/URI action，属于不可信输入。PDF.js 对注释链接通常会做协议校验，但这里直接使用 `getOutline()` 返回的 URL。恶意 PDF 可放入 `javascript:`、`data:`、自定义协议或钓鱼 URL：

- `javascript:` 在部分浏览器/旧版本中可能在新窗口上下文执行；`noopener` 降低了同源风险，但不应依赖。
- 自定义协议可能唤起本地应用（如 `ms-msdt:`、`search-ms:` 等），属于危险协议。
- 钓鱼 URL 会显示为文档目录项，用户容易信任。

**修复建议**

```js
function safeOutlineUrl(raw) {
  try {
    const url = new URL(raw, window.location.href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const target = safeOutlineUrl(item.url);
if (target) {
  window.open(target, '_blank', 'noopener,noreferrer');
} else {
  showToast('该书签链接被拒绝。', 'error');
}
```

**验证方法**

- 构造含 `javascript:alert(1)`、`data:text/html,...`、`file:///etc/passwd` 的 outline 测试 PDF，点击后不执行/不打开。
- 正常 `https://example.com` 书签仍可打开。

---

### P2-3 无 CSRF/Origin 防护（为未来认证预留）

> **修复状态（2026-10-22 复核）**：**已修复**。状态变更接口校验 `Origin` / `Sec-Fetch-Site`，支持 `ALLOWED_ORIGINS`；详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始发现问题与建议。

**位置**

- `server/app.js:54-85`：`POST` / `DELETE` 没有任何 CSRF token 或 `Origin` 校验。
- 当前没有 Cookie 认证，所以跨站表单无法直接利用：
  - `express.json()` 只解析 `application/json`；跨站表单默认 `application/x-www-form-urlencoded` / `multipart/form-data`，`req.body` 为空 → 400。
  - 跨站 `fetch` 带 `Content-Type: application/json` 会触发 CORS 预检；服务端没有 `Access-Control-Allow-Origin`，浏览器会拦截。
  - `DELETE` 不能由 HTML 表单直接发出。

**风险**

一旦按 P0-3 加入 Cookie 会话，`POST /api/documents`、`DELETE /api/documents/:id` 会立即变成 CSRF 目标（攻击者可以诱导已登录用户创建/删除文档，或触发 LFI/SSRF）。

**修复建议**

- Cookie：`SameSite=Strict`（或 `Lax` + CSRF token）、`Secure`、`HttpOnly`。
- 双提交 Cookie 或同步 token；对 `POST`/`DELETE` 校验 `Origin`/`Referer`/`Sec-Fetch-Site`。
- 不要把 `GET /content` 设计成有副作用的接口（当前没有，但 `?download` 只是响应头）。
- 认证 token 放在 `Authorization` 头时，天然不受 CSRF 影响。

**验证方法**

- 跨站表单/`fetch` 无法创建/删除文档。
- 缺失/错误 CSRF token 返回 403。
- `Origin` 不在白名单返回 403。

---

### P2-4 临时镜像清理与上限

> **修复状态（2026-10-22 复核）**：**已修复**。临时镜像落盘已移除；启动时清理旧版本 `stream-pdf-*` 残留；详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始发现问题与建议。

**位置**

- `server/sources.js:209-264` `mirrorRemoteFile()`
- `server/documents.js:67-84` `remove()`
- `server/index.js:27-48` `shutdown()`

**问题**

- `mirrorRemoteFile()` 用 `mkdtemp()` 在 `os.tmpdir()` 下创建目录，成功后由 `doc.cleanupDir` 记录；正常删除/TTL 会清理。
- 进程崩溃、`SIGKILL`、容器重启时不会清理，最多每个文档 64 MB 残留。
- `shutdown()` 只 `store.stop()`，没有遍历清理 `cleanupDir`；`server.close()` 后直接 `process.exit(0)`。
- `REMOTE_MIRROR_LIMIT_MB` 没有上限，配置成 10240 会允许 10 GB 镜像。
- `remove()` 在 `activeRequests > 0` 时延迟 30 秒清理；若进程在 30 秒内退出，残留。

**修复建议**

1. 启动时清理旧目录：

```js
// 仅清理本应用的临时目录，且只删除超过一定时间的
const tmp = os.tmpdir();
for (const name of await fsp.readdir(tmp)) {
  if (!name.startsWith('stream-pdf-')) continue;
  const full = path.join(tmp, name);
  const stat = await fsp.stat(full).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > 24 * 3600 * 1000) {
    await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}
```

2. 退出时清理：

```js
async function shutdown(signal) {
  // ...
  for (const doc of store.docs.values()) {
    await cleanupSource(doc).catch(() => {});
  }
  store.stop();
  // ...
}
```

3. `REMOTE_MIRROR_LIMIT_MB` 加硬上限（例如 512 MB），并在启动时校验。
4. 镜像目录使用独立 tmpfs/quota，避免与系统 `/tmp` 共享。
5. 记录镜像总量指标，接近配额时拒绝新镜像。

---

### P2-5 Windows 路径白名单比较

> **修复状态（2026-10-22 复核）**：**已失效并加固**。本地路径模式已删除，路径白名单问题不再适用；文件名/显示文本的控制字符、双向覆盖与长度限制已加固；详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始发现问题与建议。

**位置**

- `server/sources.js:482`

```js
const allowed = configured.some(
  (root) => realPath === root || realPath.startsWith(`${root}${path.sep}`),
);
```

**问题**

- Windows 路径大小写不敏感：`C:\PDFs` 与 `c:\pdfs` 可能被误判为不允许（可用性问题）。
- Windows 8.3 短文件名（`PROGRA~1`）与长文件名可能不一致；`realpath` 通常返回长路径，但需测试。
- 前缀比较在 Linux 上配合 `path.sep` 是安全的（`/data-evil` 不会匹配 `/data`），但 Windows 分隔符/大小写需要额外处理。

**修复建议**

```js
const isWindows = process.platform === 'win32';
const normalize = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));

const rel = path.relative(normalize(root), normalize(realPath));
const allowed =
  rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
```

并在 Windows 上增加短文件名/大小写回归测试。

---

### P3 持续加固

> **修复状态（2026-10-22 复核）**：**仓库层已完成**。CI/依赖扫描、Dependabot、结构化脱敏日志、指标、`SECURITY.md`、`.gitignore`、systemd/nginx/Docker 加固模板均已落地；主机/网络层配置仍由运维执行。详见 [P2/P3 修复复核详情](#p2p3-修复复核详情2026-10-22)。以下保留原始建议。

- **依赖与供应链**：`npm ci`、提交 lockfile、CI 运行 `npm audit --omit=dev`、Dependabot/Renovate、固定 Node 版本（升级 pdfjs 后 `>=22.13`）。
- **容器/主机**：非 root、只读根文件系统、`no-new-privileges`、`cap_drop: ALL`、seccomp、`PrivateTmp`、`MemoryMax`、`TasksMax`、只读挂载 PDF 目录、出站防火墙。
- **TLS**：反向代理终止 TLS，强制 HTTPS，HSTS；不要直接暴露 Node 的 HTTP 端口。
- **日志**：结构化、脱敏 URL/路径/token；保留认证失败、文档打开、上游失败；接入 SIEM/告警。
- **监控**：文档数、镜像磁盘、活动连接、5xx、上游超时、异常 4xx 突增。
- **备份/恢复**：临时镜像不需备份；配置与允许目录清单需备份。
- **安全文档**：在 `SECURITY.md` 写明威胁模型、支持版本、漏洞上报方式；README 的“安全说明”更新为“默认安全配置 + 公网部署清单”。
- **`.gitignore`**：加入 `.env`、`*.pem`、`*.key`，避免误提交密钥。
- **CI 安全测试**：把 P0/P1 的回归用例纳入 `npm test`。

---

## 3. 推荐公网部署架构

```text
Internet
   │  HTTPS / WAF / DDoS / Bot 防护
   ▼
CDN / Cloudflare / 云 WAF
   │
   ▼
nginx / Caddy（TLS 终止、限流、请求体限制、安全头）
   │  auth_request / forward_auth
   ▼
OAuth2-proxy / Authentik / Authelia / Cloudflare Access
   │  仅允许已认证用户
   ▼
StreamPDF  Node.js  127.0.0.1:3000
   │  非 root、只读根 FS、只读挂载 /srv/pdfs
   ├── 本地 PDF：仅 /srv/pdfs（PDF_ALLOWED_ROOTS）
   └── 远程 URL：默认关闭；启用时仅白名单 CDN + 出站防火墙
```

**关键原则**

1. Node 进程只监听 `127.0.0.1` 或 Unix socket，不直接对公网。
2. 认证在代理层完成，应用层再做一次 token 校验（纵深防御）。
3. 本地文件默认关闭，只读挂载允许目录。
4. 远程 URL 默认关闭；开启时必须做 IP/重定向/DNS pinning 校验 + 出站防火墙。
5. 限流、配额、超时、磁盘配额在代理层和应用层都配置。
6. 日志脱敏、监控告警、备份配置。

---

## 4. 建议的环境变量（新增/调整）

> 本节为修复前的建议清单，保留作设计参考。修复后实际生效的变量与默认值见 [1.1 修复复核详情](#11-修复复核详情2026-10-21) 的“修复后实际配置”。

| 变量 | 建议默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 保持回环；由反向代理接入 |
| `PORT` | `3000` | 不变 |
| `PUBLIC_MODE` | `1`（公网） | 启用公网安全默认值 |
| `AUTH_TOKEN` | 必填（公网） | 应用层 Bearer token；或由代理注入 |
| `ALLOWED_HOSTS` | 必填（公网） | 逗号分隔的 Host 白名单 |
| `PDF_ALLOWED_ROOTS` | 必填（若允许本地） | 只读挂载的 PDF 目录 |
| `ALLOW_LOCAL_FILES` | `0`（公网） | 关闭路径模式 |
| `ALLOW_REMOTE_URLS` | `0`（公网） | 关闭远程 URL；或配域名白名单 |
| `REMOTE_URL_ALLOWLIST` | 空 | 例如 `cdn.example.com:443` |
| `MAX_DOCUMENTS` | `100` | 全局文档数上限 |
| `MAX_DOCUMENTS_PER_IP` | `5` | 每 IP 会话上限 |
| `MAX_TOTAL_MIRROR_BYTES` | `268435456`（256 MB） | 临时镜像总量上限 |
| `MAX_REMOTE_BYTES` | `2147483648`（2 GB） | 单文档远端最大字节 |
| `DOCUMENT_TTL_MINUTES` | `30` | 公网建议缩短 |
| `REMOTE_MIRROR_LIMIT_MB` | `32` | 并加硬上限 |
| `ENABLE_HSTS` | `1`（HTTPS） | 由代理或应用设置 HSTS |
| `TRUST_PROXY` | `1`（代理后） | 仅信任已知代理 |

启动时校验示例（`server/index.js`）：

```js
const host = process.env.HOST || '127.0.0.1';
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
const publicMode = process.env.PUBLIC_MODE === '1';

if (!isLoopback && publicMode) {
  if (!process.env.AUTH_TOKEN) {
    console.error('拒绝启动：公网模式必须配置 AUTH_TOKEN。');
    process.exit(1);
  }
  if (!process.env.ALLOWED_HOSTS) {
    console.error('拒绝启动：公网模式必须配置 ALLOWED_HOSTS。');
    process.exit(1);
  }
  if (process.env.ALLOW_LOCAL_FILES !== '0' && !process.env.PDF_ALLOWED_ROOTS) {
    console.error('拒绝启动：允许本地文件时必须配置 PDF_ALLOWED_ROOTS。');
    process.exit(1);
  }
}
```

---

## 5. nginx 参考配置

```nginx
server {
  listen 443 ssl http2;
  server_name pdf.example.com;

  ssl_certificate     /etc/letsencrypt/live/pdf.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pdf.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;

  client_max_body_size 64k;
  client_body_timeout 10s;
  client_header_timeout 10s;
  send_timeout 60s;

  # 认证：二选一
  # auth_basic "StreamPDF";
  # auth_basic_user_file /etc/nginx/.htpasswd;
  # 或 auth_request /oauth2/auth;

  location / {
    limit_req zone=streampdf burst=20 nodelay;
    limit_conn streampdf 20;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_buffering off;
  }
}

# http {} 中：
# limit_req_zone $binary_remote_addr zone=streampdf:10m rate=10r/s;
# limit_conn_zone $binary_remote_addr zone=streampdf:10m;
```

> 说明：`proxy_buffering off` 适合流式 PDF；`limit_req` 的速率需按实际用户量调整，避免误伤正常翻页。

---

## 6. systemd 加固参考

```ini
[Service]
User=streampdf
Group=streampdf
WorkingDirectory=/opt/streampdf
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=PUBLIC_MODE=1
Environment=PDF_ALLOWED_ROOTS=/srv/pdfs
EnvironmentFile=/etc/streampdf/streampdf.env
ExecStart=/usr/bin/node /opt/streampdf/server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/pdfs
ReadWritePaths=/var/tmp/streampdf
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryMax=1G
TasksMax=256
LimitNOFILE=4096
```

**要点**

- `ProtectHome=true` 防止进程读取 `/home`（与 P0-1 纵深防御）。
- `ReadOnlyPaths=/srv/pdfs` 只读挂载允许目录。
- `PrivateTmp=true` 隔离临时镜像。
- `MemoryMax`/`TasksMax`/`LimitNOFILE` 限制资源。
- 如允许远程 URL，需保留 `AF_INET/AF_INET6`，并用防火墙限制出站目标。

---

## 7. 回归测试清单（建议加入 `npm test`）

### 访问控制

- [ ] 未认证访问 `/api/documents`、`/api/documents/:id`、`/content`、`/stats`、`DELETE` 均返回 401。
- [ ] 错误 token 返回 401，且响应不泄露 token 是否存在。
- [ ] 用户 A 不能读取/删除用户 B 的文档（多用户场景）。
- [ ] `GET /api/health` 公网只返回 `{ ok: true }`。

### 本地文件

- [ ] `PDF_ALLOWED_ROOTS` 未设置时，路径读取返回 403。
- [ ] 允许目录内 PDF 返回 201；目录外返回 403。
- [ ] 目录穿越 `../`、符号链接指向外部、`..%2f` 等均被拒绝。
- [ ] 响应不含绝对路径。
- [ ] 非 PDF 与不存在文件返回一致/脱敏的错误。
- [ ] Windows 大小写/短文件名回归（如适用）。

### SSRF

- [ ] `127.0.0.1`、`localhost`、`[::1]` 被拒绝。
- [ ] `10/8`、`172.16/12`、`192.168/16`、`169.254/16` 被拒绝。
- [ ] `2130706433`、`0x7f000001`、`0177.0.0.1` 等编码被拒绝。
- [ ] IPv4-mapped IPv6、NAT64、6to4、Teredo 被拒绝。
- [ ] 公网 URL 302 到私网被拒绝。
- [ ] DNS rebinding（mock lookup）被拒绝。
- [ ] 正常公网 PDF 仍可打开。
- [ ] 上游超时/超大响应被中止。

### 资源限制

- [ ] 超过 `MAX_DOCUMENTS` 返回 503。
- [ ] 超过每 IP 配额返回 429。
- [ ] 超过镜像总量返回 507/429。
- [ ] 限流触发 429。
- [ ] 慢上游/慢客户端在超时后释放。
- [ ] 无 Range 超大远端被中止。

### Host / CSRF / 头

- [x] 非白名单 Host 返回 421。
- [x] 非回环绑定且未设置 `ALLOWED_HOSTS` 时拒绝启动。
- [x] 跨站 POST/DELETE 被拒绝（`Origin` / `Sec-Fetch-Site`；当前另有 Bearer 认证）。
- [x] `ALLOWED_ORIGINS` 白名单生效，非法配置启动即失败。
- [x] HSTS/COOP/CORP/Permissions-Policy 存在。
- [x] `/content` 直接导航带 `sandbox` CSP。

### 日志 / 监控 / 供应链

- [x] 结构化 JSON 日志，自动脱敏 token/URL query/绝对路径/控制字符。
- [x] 可选 `/api/metrics` 需认证、默认关闭；周期 `metrics.snapshot`。
- [x] CI 运行 `npm ci`、`npm test`、`npm audit --omit=dev --audit-level=high`。
- [x] Dependabot 覆盖 npm 与 GitHub Actions。
- [x] `SECURITY.md`、`.gitignore` 密钥规则、`.dockerignore`。
- [x] systemd / nginx / Docker / Compose 加固模板。

### 前端

- [x] `?path=` / `?url=` 不再自动触发。
- [x] 恶意 outline URL 被拒绝。
- [x] 恶意 PDF 不执行脚本（PDF.js 升级后）。

---

## 8. 已有安全控制（值得保留）

> 以下为修复后仍然有效的控制；随本地路径/临时镜像删除而失效的条目已移除。新增 P0 控制见 [1.1 修复复核详情](#11-修复复核详情2026-10-21)。

- 文档 ID 使用 `crypto.randomUUID()`（UUIDv4），不可顺序猜测。
- 文档会话默认 30 分钟闲置 TTL + 10 分钟清理定时器（`unref`）。
- 支持 Range 的远端 PDF 才允许打开；PDF 魔数 `%PDF-` 检查，避免把任意文件当 PDF 返回。
- Range 解析严格：只接受单段、拒绝多段、检查安全整数、越界返回 416。
- 远端 `Content-Range`/`Content-Length`/实际字节数一致才转发，避免截断或越界响应。
- `Content-Disposition` 对文件名做控制字符/引号/反斜杠处理，`filename*` 使用 `encodeURIComponent`。
- `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer`、COOP/CORP/Permissions-Policy。
- CSP 无 `'unsafe-inline'`/`'unsafe-eval'`（style 除外），可阻断常见 XSS；`/content` 额外加 `sandbox` CSP。
- 无 CORS 响应头，降低跨站读取 API 的风险。
- `express.json({ limit: '32kb' })` 在认证之后解析，未认证请求不能消耗 JSON 解析资源；URL 长度限制 8192。
- `app.disable('x-powered-by')`，不暴露框架版本。
- `server/host.js` 严格校验 `Host`：默认仅回环主机名，`ALLOWED_HOSTS` 可配置；不匹配返回 421，非回环绑定强制配置。
- 文档元数据最小化；远端错误不回显上游状态码/主机/端口；所有 API 与错误响应 `Cache-Control: no-store`。
- 前端不读取查询字符串，打开文档必须由用户显式操作；静态测试防止 `?path`/`?url` 自动打开回归。
- 无 `child_process`/`eval`/SQL/反序列化；服务端攻击面主要是远端网络。
- PDF.js 配置 `enableScripting: false`、`enableXfa: false`、`maxCanvasPixels` 限制、`disableAutoFetch`/`disableStream` 控制浏览器资源。
- 错误处理在响应头发送后销毁连接，避免半截响应；客户端中断不会记录为 500。
- 优雅退出有 5 秒强制超时和 `unref` 定时器。
- 状态变更 API 校验 `Origin` / `Sec-Fetch-Site`，支持 `ALLOWED_ORIGINS`；危险 PDF outline 协议被拒绝。
- 结构化日志自动脱敏，不记录 token/Cookie/URL query/绝对路径/堆栈；`X-Request-Id` 贯穿请求。
- 非回环绑定强制显式 `AUTH_TOKEN`；非交互随机令牌写入 `0600` 文件而非日志。
- CI 依赖审计与 Dependabot、`SECURITY.md`、systemd/nginx/Docker 加固模板已纳入仓库。

---

## 9. 修复路线图

> 以下保留原始路线图，并标注 2026-10-21 复核状态。

### 第 0 步：在公网暴露前（P0，阻断）

1. ✅ 加认证（应用层 Bearer token；反向代理认证仍推荐）。
2. ✅ 删除本地路径模式；服务端不再读取客户端指定的文件（比 fail-closed 更彻底）。
3. ✅ 实现公网 IP 校验、DNS pinning、逐跳重定向校验、端口限制与超时；出站防火墙仍需部署层配置。
4. ✅ 升级 `pdfjs-dist` 到 `6.4.299`，显式 `enableScripting: false`、`enableXfa: false`。
5. ✅ 加文档数/每 IP 配额/并发/上游超时/响应大小/速率限制；临时镜像已删除。
6. ✅ 应用层 Host 白名单已实现；非回环绑定必须设置 `ALLOWED_HOSTS`，反向代理仍应配置 `server_name`。

### 第 1 周（P1）

7. ✅ 移除 `?path`/`?url` 自动打开，并加静态回归测试。
8. ✅ 脱敏绝对路径、错误信息、健康/配置信息、上游状态码与主机。
9. ✅ 补全安全头与缓存策略；`/content` 加 `sandbox` CSP 与 `no-store`。
10. ✅ 临时镜像已删除，无需再清理镜像残留。

### 第 2–4 周（P2/P3）

11. ✅ outline URL 协议白名单。
12. ✅ 当前使用 Authorization 头认证，不使用 Cookie；若未来改用 Cookie，必须补 CSRF/Origin 防护。
13. ✅ 本地路径模式已删除；文件名/显示文本的控制字符、Unicode 双向覆盖与长度限制已加固，Windows 路径白名单问题不再适用。
14. ✅ CI 安全测试、依赖扫描（`npm audit` + dependency-review）、Dependabot、systemd/nginx/Docker 加固模板已加入仓库；主机/网络层配置仍由运维落地。
15. ✅ `SECURITY.md` 与公网部署清单已补充；`README.md` 已同步 P2/P3 加固说明。

---

## 10. 附录

### A. `npm audit` 原始输出

```text
# npm audit report

pdfjs-dist
Severity: high
PDF.js: Arbitrary JavaScript execution upon opening a malicious PDF
https://github.com/advisories/GHSA-hq66-cqwq-w95j
No fix available
node_modules/pdfjs-dist

1 high severity vulnerability
```

**复核后（2026-10-21，`pdfjs-dist@6.4.299`）：**

```text
found 0 vulnerabilities
```

### B. 本次动态验证的环境

- Node.js `v24.19.0`，npm `11.17.0`
- 应用监听 `127.0.0.1` 临时端口
- 内部服务监听 `127.0.0.1` 临时端口，返回带 `%PDF-` 的测试内容
- 未修改仓库文件；仅读取本机已有 PDF 做 LFI 证明

### B.1 修复复核环境与结果

- Node.js `v24.19.0`
- `npm test`：34 项通过，0 失败
- `npm audit --omit=dev`：0 vulnerabilities
- 使用 `test-pdf/大辞海：法学卷.pdf`（约 1.1 GB）经本地 Range 测试服务验证分片读取
- 使用 PDF.js 6 实际解析该 PDF 成功（868 页）
- 未进行真实图形浏览器点击回归（环境无浏览器）

### C. 参考

- OWASP SSRF Prevention Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>
- OWASP Path Traversal: <https://owasp.org/www-community/attacks/Path_Traversal>
- OWASP ASVS: <https://owasp.org/www-project-application-security-verification-standard/>
- Node.js Security Best Practices: <https://nodejs.org/en/learn/getting-started/security-best-practices>
- Express Security Best Practices: <https://expressjs.com/en/advanced/best-practice-security.html>
- GHSA-hq66-cqwq-w95j: <https://github.com/advisories/GHSA-hq66-cqwq-w95j>
- CVE-2026-16633: <https://www.cve.org/CVERecord?id=CVE-2026-16633>
- CWE-22 (Path Traversal): <https://cwe.mitre.org/data/definitions/22.html>
- CWE-918 (SSRF): <https://cwe.mitre.org/data/definitions/918.html>
- CWE-306 (Missing Authentication): <https://cwe.mitre.org/data/definitions/306.html>
- CWE-79 (XSS): <https://cwe.mitre.org/data/definitions/79.html>
- CWE-400 (Resource Exhaustion): <https://cwe.mitre.org/data/definitions/400.html>
- CWE-644 (Host Header): <https://cwe.mitre.org/data/definitions/644.html>

### D. 审计限制

- 本次未做完整的基础设施/云配置审计、依赖供应链审计、浏览器深度 fuzzing、PDF 解析器 fuzzing。
- 未对生产部署的 nginx/容器/防火墙配置做实测。
- 原始动态验证在本地回环进行，未扫描外部网络。
- 漏洞利用受环境权限影响；例如本机 `/root` 不可读时返回 `EACCES`，在权限允许的部署中可读取任意 PDF。
- 修复建议中的代码为示意，落地时需结合现有测试与部署方式调整。
- 复核未做真实图形浏览器点击回归；前端仅做语法检查，服务端/API 和 PDF.js 解析链路已实测。

---

**最终建议**：P0-1 ~ P0-5、P1-1 ~ P1-3、P2-1 ~ P2-5 与 P3 加固项均已在应用/仓库层处理完毕，但公网部署前仍应：

1. 优先保持 `HOST=127.0.0.1`，由 nginx/Caddy 终止 TLS，并配置 `server_name`/Host 白名单；如绑定非回环地址，必须设置 `ALLOWED_HOSTS` 与强随机 `AUTH_TOKEN`。
2. 在反向代理层再做认证/限流，并按需配置 `ALLOWED_ORIGINS`、`ENABLE_HSTS=1`。
3. 在主机/容器/防火墙限制出站流量，阻断到 RFC1918、`169.254.0.0/16` 和本机的连接；应用层 SSRF 校验不替代网络层控制。
4. 采用 `deploy/` 下的 systemd/nginx/Docker 模板，完成非 root、只读根文件系统、capability 收紧、资源限制与 `SECURITY.md` 中的公网部署清单。
5. 接入 JSON 日志/SIEM 与告警（401/429/5xx、认证失败、上游失败、文档数、并发流），必要时开启 `ENABLE_METRICS=1`。
