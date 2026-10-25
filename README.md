# StreamPDF

用 Node.js 作为后端、PDF.js 作为渲染引擎的流式 PDF 预览器。输入**公网 HTTP(S) PDF 直链**，即可在浏览器中按需加载、平滑浏览 GB 级 PDF。默认按**公网严格模式**设计；可信内网可显式开启内网模式，访问私网地址和宿主服务。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-2f8f5b)
![PDF.js](https://img.shields.io/badge/PDF.js-6.4-7c5cff)
![License](https://img.shields.io/badge/license-MIT-blue)

> **安全模型变更**：服务器端本地文件读取（路径模式）已完全移除。StreamPDF 只通过 HTTP(S) 从远端加载 PDF，不再接受任何服务器文件路径。所有 `/api/*` 文档接口都需要 Bearer 访问令牌。
>
> **地址策略**：默认是公网严格模式，只允许公网 HTTP(S) 地址和 `ALLOWED_REMOTE_PORTS`（默认 80/443）。仅在可信内网中设置 `ALLOW_PRIVATE_ADDRESSES=1`，才会允许 RFC1918 私网、CGNAT、IPv6 ULA、回环/宿主地址以及任意端口；即使开启内网模式，链路本地/云元数据、组播和保留地址仍会被阻断。

## 为什么大文件也能快速打开

普通 PDF 预览方案往往先把整个文件下载进内存，再交给渲染器。一个 1.8 GB 的文件意味着数秒到数分钟的等待，以及随时可能触发的内存溢出。

StreamPDF 把“加载 PDF”拆成按需的 HTTP Range 请求：

```text
浏览器 PDF.js
   │  1. 需要文件头 / xref / 某个页面对象
   ▼
GET /api/documents/:id/content
Authorization: Bearer <token>
Range: bytes=1048576-2097151
   │
   ▼
Node 服务端校验目标地址并转发 Range 请求
   │
   ▼
206 Partial Content
Content-Range: bytes 1048576-2097151/1932735283
```

- **服务端只做受控代理**：不读取服务器本地文件，不落盘缓存 PDF 内容。
- **远端 URL 代理**：解决浏览器跨域限制；远端支持 Range 时逐块转发。
- **PDF.js 严格按需**：`disableAutoFetch` + `disableStream` + 1 MiB `rangeChunkSize`，只取当前需要的分片。
- **页面虚拟化**：使用 PDF.js 官方 `PDFViewer` 渲染队列，只为视口附近的页面创建画布，离开视口的画布会被回收。
- **内存占用与文件大小解耦**：打开 2 GB 文件并不比打开 20 MB 文件多占用 2 GB 内存。

侧栏会实时显示服务器实际传输的字节数、Range 请求次数和当前连接状态，方便确认文档并没有被整体下载。

## 快速开始

环境要求：Node.js **22.13.0 或更高版本**（PDF.js 6.x 的要求）。

```bash
npm install

# 推荐：设置一个固定访问令牌（至少 16 个字符）
AUTH_TOKEN='replace-with-a-long-random-token' npm start
```

不设置 `AUTH_TOKEN` 时，服务会在每次启动时生成一个随机令牌：交互式终端直接打印；非交互进程（systemd、容器、日志采集）写入当前目录的 `.auth-token`（权限 `0600`），写入失败则拒绝启动。生产环境请显式设置 `AUTH_TOKEN`。打开终端中输出的地址：

```text
http://127.0.0.1:3000
```

页面会要求输入访问令牌。输入终端打印的令牌（或你设置的 `AUTH_TOKEN`）后：

1. 粘贴 PDF 直链，例如 `https://example.com/files/manual.pdf`；可信内网中（`ALLOW_PRIVATE_ADDRESSES=1`）也可以使用 `http://192.168.1.20:8080/files/manual.pdf`。
2. 回车或点击“打开文档”。

> URL 由 **Node 服务端**请求，因此目标地址必须能从服务器访问。默认公网严格模式只允许公网地址和 80/443 端口；内网模式则允许私网、本机和宿主服务地址（包括非标准端口），只保留对链路本地/云元数据、组播和保留地址的阻断。

### 生成测试 PDF

仓库附带两个生成脚本，用于制造大文件并通过任意支持 Range 的 HTTP 服务访问：

```bash
# 输出到 test-output/streampdf-sample.pdf，300 页，约 12 MB
npm run sample

# 自定义：输出路径、页数、填充 MB 数
node scripts/make-sample-pdf.mjs test-output/big.pdf 1200 512
```

大填充数据是 PDF 中合法但未被页面引用的 stream，用来制造大文件并验证 Range 请求，不会明显拖慢单页渲染。

```bash
# 默认：201 页、约 1 GB，页对象分散在填充空洞之间
npm run sample:gb

# 自定义：输出路径、页数、目标大小（MB）
node scripts/make-gb-sample-pdf.mjs test-output/huge.pdf 501 2048
```

生成后请用支持 Range 的静态服务器提供这些文件，再把直链粘贴到 StreamPDF。项目不再支持直接输入本地路径。

## 使用方式

- **访问令牌**：所有文档 API 使用 `Authorization: Bearer <token>`；令牌只保存在当前浏览器 `sessionStorage`。
- **最近打开**：成功的 URL 会保存在浏览器 `localStorage`，最多 6 条。
- **页码跳转**：工具栏页码输入框回车即可跳到任意页。
- **缩放 / 适应宽度 / 旋转**：工具栏按钮。
- **文档目录**：侧栏读取 PDF outline，点击可跳转；最多展示 2500 项以防止超长目录拖慢界面。
- **实时传输统计**：每 1.5 秒读取一次服务端 Range 统计。
- **快捷打开**：`Ctrl/Cmd + O`。
- **不再支持 URL 参数自动打开**：`?path=`、`?url=`、`?open=` 均不会触发服务端读取；打开文档必须由用户主动提交。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。建议保持回环，前面放反向代理 |
| `ALLOWED_HOSTS` | 空（仅 `localhost`、`127.0.0.1`、`::1`） | 逗号分隔的 Host 白名单（可带端口）。`HOST` 绑定非回环地址时必须设置；不匹配的请求返回 421 |
| `AUTH_TOKEN` | 随机生成 | 访问令牌，至少 16 个可打印非空格字符。非回环绑定必须显式设置；未设置时本地交互式终端打印随机值，非交互进程写入 `./.auth-token`（0600） |
| `MAX_DOCUMENTS` | `100` | 全局文档会话数上限，超过返回 503 |
| `MAX_DOCUMENTS_PER_IP` | `5` | 每个客户端 IP 的文档会话数上限，超过返回 429 |
| `MAX_REMOTE_BYTES` | `2147483648`（2 GiB） | 单次内容响应的最大字节数（无 Range 的完整响应，或覆盖整个文件的单个 Range 请求）；超限中止连接 |
| `DOCUMENT_TTL_MINUTES` | `30` | 文档会话闲置过期时间（分钟） |
| `MAX_CONCURRENT_STREAMS` | `100` | 同时进行的内容流上限，超过返回 503 |
| `ALLOWED_REMOTE_PORTS` | `80,443` | 允许访问的远端端口，逗号分隔；内网模式下不限制端口 |
| `ALLOW_PRIVATE_ADDRESSES` | `0`（关闭） | 默认公网严格模式：只允许公网地址与端口白名单。设为 `1` 开启内网模式：允许私网、CGNAT、IPv6 ULA、回环/宿主地址与任意端口（仍拒绝链路本地/云元数据等） |
| `TRUST_PROXY` | 空 | 设为 `1` 时信任一层反向代理的 `X-Forwarded-For`，用于按真实客户端 IP 计算配额/限流。仅在应用只接受可信代理连接时启用 |
| `REMOTE_HEADERS_TIMEOUT_MS` | `20000` | 连接远端、等待响应头的超时 |
| `REMOTE_BODY_IDLE_TIMEOUT_MS` | `30000` | 读取远端响应体时的空闲超时 |
| `ENABLE_HSTS` | 空 | 设为 `1` 时发送 HSTS 头；仅在 HTTPS 反向代理后启用 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的 `scheme://host[:port]`。默认只接受同源的状态变更请求；独立前端域名必须显式列出 |
| `ENABLE_METRICS` | 空 | 设为 `1` 时开放需 Bearer 认证的 `GET /api/metrics` 聚合指标（默认关闭） |
| `LOG_LEVEL` | `info` | 结构化日志级别：`debug`、`info`、`warn`、`error`、`silent` |
| `METRICS_LOG_INTERVAL_MINUTES` | `15` | 周期性输出 `metrics.snapshot` 的间隔；`0` 关闭 |

示例：

```bash
AUTH_TOKEN='a-very-long-random-token' \
MAX_DOCUMENTS=50 \
MAX_DOCUMENTS_PER_IP=3 \
PORT=8080 \
npm start
```

文档创建、内容读取和删除接口还有进程内每 IP 限流：创建默认 10 次/分钟、内容读取 600 次/分钟、删除 30 次/分钟。连续失败的认证尝试默认限制为 10 次/分钟。`MAX_CONCURRENT_STREAMS` 默认 100；浏览器通常每个源只并发数个请求，普通预览不会触及上限；如果使用非浏览器客户端并一次发起大量并发 Range 请求，可能收到 503，可按需调高。即使部署在内网，仍建议在反向代理层再配置 `limit_req` / `limit_conn`。

如果需要通过域名或 IP 从其他机器访问（或设置 `HOST=0.0.0.0`），必须同时设置 `ALLOWED_HOSTS`，并把反向代理的 `Host` 头原样传给 Node：

```bash
HOST=0.0.0.0 \
ALLOWED_HOSTS='pdf.example.com,192.168.1.10,localhost' \
AUTH_TOKEN='a-very-long-random-token' \
npm start
```

`ALLOWED_HOSTS` 只做 Host 白名单匹配，不代替认证；`HOST` 非回环且未设置 `ALLOWED_HOSTS` 时进程会拒绝启动。未设置该项时只接受 `localhost`、`127.0.0.1`、`::1` 及其带端口形式，用于本地访问。

绑定非回环地址时还必须显式设置 `AUTH_TOKEN`。未设置时，本地交互式终端会打印随机令牌；如果 stdout 不是终端（systemd、容器、日志采集），随机令牌会写入当前目录的 `.auth-token`（权限 `0600`），写入失败则拒绝启动——这样令牌不会进入日志。生产环境请始终使用 `AUTH_TOKEN`/`EnvironmentFile`。

如果前端部署在**另一个源**（例如 `https://app.example.com` 调用 `https://pdf.example.com`），必须配置 `ALLOWED_ORIGINS=https://app.example.com`；否则状态变更接口会返回 `CROSS_SITE_REQUEST`。

## 远端 URL 的行为

标准静态文件服务器、对象存储、CDN 通常都支持 Range，可以直接流式打开。

**远端必须支持 Range。** 如果远端忽略 `Range` 并返回 `200`，服务端会拒绝打开（`REMOTE_NO_RANGE`），不会把文件下载到服务器磁盘或内存中缓存。这是为了保持“只通过 HTTP 按需加载”的安全模型，并避免磁盘/内存耗尽。

以下情况无法打开：

- 登录态/签名链接、需要 Cookie 或特殊请求头的地址；
- 返回 HTML 网页而不是 PDF 文件本身；
- 强制压缩传输（`Content-Encoding: gzip` 等）的地址，字节范围语义不可靠；
- 不支持 Range 的地址；
- 链路本地/云元数据、组播、保留地址，以及 IPv6 转换/隧道地址（NAT64、6to4、Teredo）；
- 默认公网严格模式下的本机、内网地址和非 80/443 端口（可信内网可设 `ALLOW_PRIVATE_ADDRESSES=1` 开启内网模式）。

加密 PDF 会在浏览器中弹出密码输入框；密码只在当前内存中的 PDF.js 实例里使用，不会发送给服务端。

## 开发与测试

```bash
npm run dev    # Node --watch 模式
npm test       # 认证、SSRF、Range 代理、限流、资源上限、CSRF、日志脱敏等测试
npm audit --omit=dev --audit-level=high   # 生产依赖漏洞扫描（CI 也会执行）
```

测试覆盖：

- 未认证/错误令牌访问文档 API 返回 401；
- 本地路径模式被拒绝（`LOCAL_FILES_DISABLED`）；
- 默认公网严格模式拒绝回环、私网、链路本地、云元数据、IPv4 编码、IPv4-mapped IPv6、NAT64、6to4 等 SSRF 目标；
- 显式开启内网模式（`ALLOW_PRIVATE_ADDRESSES=1`）后允许回环、私网、CGNAT、宿主服务与非标准端口，链路本地/云元数据、组播、保留地址仍被拒绝；
- 非 HTTP(S) 协议、URL 内嵌凭据、严格模式下的非白名单端口被拒绝；
- 重定向逐跳重新校验；
- 远端 PDF 的精确 Range 响应、`206`、`416`、`HEAD`；
- 不支持 Range 的远端被明确拒绝；
- 全局/每 IP 文档数、创建限流、上游超时、无 Range 响应大小上限；
- 非白名单 `Host` 返回 421，回环与显式配置的域名可正常访问；
- 文档元数据不包含绝对路径、owner IP、上游 URL、ETag/Last-Modified 等内部信息；
- 远端错误不再回显上游状态码、主机名或端口；
- 前端不再解析 `?path=` / `?url=` / `?open=`，不会在页面加载时触发服务端读取；
- `pdfjs-dist` 版本高于 CVE 影响范围，且前端显式 `enableScripting: false`；
- 安全响应头齐全（CSP、COOP、CORP、Permissions-Policy、HSTS 开关等）；
- 跨站 `Origin` / `Sec-Fetch-Site` 状态变更请求被拒绝，`ALLOWED_ORIGINS` 白名单生效；
- PDF 目录链接只允许 `http` / `https` / `mailto`，拒绝内嵌凭据；
- 日志脱敏（Bearer token、URL query、绝对路径、控制字符/双向覆盖字符）；
- 文件名与显示文本的控制字符、双向覆盖字符和长度限制；
- 遗留临时镜像目录只清理本应用前缀、超过 24 小时的真实目录，且不跟随符号链接；
- 可选的 `/api/metrics` 指标接口需认证、默认关闭；
- CI/加固文件静态检查（`.gitignore`、`SECURITY.md`、GitHub Actions、systemd/nginx/Docker 模板）。

也可以自行启动一个支持 Range 的测试 HTTP 服务来发送 `test-pdf/` 下的文件（该目录已被 `.gitignore` 忽略，不会进入仓库）。

## 项目结构

```text
.
├── server/
│   ├── index.js        # 启动、环境变量、令牌文件、优雅退出
│   ├── app.js          # Express 路由、认证、Host/Origin 校验、Range 响应、安全头、限流、指标
│   ├── auth.js         # Bearer 令牌生成与常量时间校验
│   ├── host.js         # Host 头解析、ALLOWED_HOSTS 白名单、DNS rebinding 防护
│   ├── origin-guard.js # CSRF/Origin/Sec-Fetch-Site 防护（P2-3）
│   ├── http-client.js  # SSRF 防护、DNS pinning、重定向校验、超时
│   ├── documents.js    # 文档会话、统计、TTL/数量/每 IP 配额
│   ├── rate-limit.js   # 进程内每 IP 固定窗口限流
│   ├── sources.js      # 远端 URL 探测、Range 代理
│   ├── filename.js     # 文件名/显示文本清洗（控制字符、双向覆盖、长度）
│   ├── logger.js       # 结构化 JSON 日志与脱敏
│   ├── temp-cleanup.js # 遗留临时镜像目录清理（P2-4）
│   ├── range.js        # Range 头解析
│   └── errors.js       # 统一错误
├── public/
│   ├── index.html      # 工作台 + 官方 PDF.js 查看器容器 + 访问令牌对话框
│   ├── styles.css      # UI、响应式布局、页面样式
│   └── js/app.js       # PDF.js 初始化、认证、打开流程、目录、统计、交互
├── deploy/
│   ├── streampdf.service        # systemd 加固单元
│   ├── streampdf.env.example    # 环境变量模板
│   ├── nginx.conf               # TLS/限流/Host 传递的站点级 drop-in 配置
│   ├── nginx-http-redirect.conf # 可选的 80 -> 443 跳转 drop-in
│   ├── Dockerfile               # 非 root、只读运行时镜像
│   └── docker-compose.yml       # cap_drop/read_only/资源限制
├── .github/
│   ├── workflows/security.yml   # CI：npm ci、npm test、npm audit、依赖审查
│   └── dependabot.yml           # npm 与 Actions 每周更新
├── scripts/
│   ├── make-sample-pdf.mjs     # 多页、带填充数据的普通测试文件
│   └── make-gb-sample-pdf.mjs  # 稀疏写入的约 1 GB 流式测试文件
├── test/
├── SECURITY.md          # 威胁模型、漏洞上报、公网部署清单
├── SECURITY-AUDIT.md    # 审计报告与修复复核
└── package.json
```

PDF.js 直接从 `node_modules/pdfjs-dist` 提供静态资源，由 `/vendor/pdfjs/*` 映射，无需打包器。

## 安全说明

本轮修复覆盖 `SECURITY-AUDIT.md` 的 5 个 P0、3 个 P1，以及全部 P2/P3 加固项：

1. **P0-1 本地文件读取（LFI）**：彻底移除 `source: "path"`、`PDF_ALLOWED_ROOTS`、本地文件探测与读取。服务端不再接受客户端提供的任何文件系统路径。
2. **P0-2 SSRF / 内网访问**：默认公网严格模式（`ALLOW_PRIVATE_ADDRESSES=0`）只允许公网 HTTP(S) 地址和 80/443 端口；解析并校验全部 DNS 结果，拒绝回环、私网、链路本地、CGNAT、云元数据、保留地址、IPv4-mapped IPv6、NAT64、6to4、Teredo 等目标。可信内网可显式设置 `ALLOW_PRIVATE_ADDRESSES=1`，此时允许私网、CGNAT、IPv6 ULA、回环/宿主地址及任意端口，但仍拒绝链路本地/云元数据、组播和保留地址。两种模式都会 pin 住已解析 IP 防 DNS rebinding、逐跳重新校验最多 3 跳重定向、禁止 URL 内嵌凭据，并设置连接/响应头/响应体空闲超时。
3. **P0-3 无认证**：所有文档接口（包括 `/api/config`、内容、统计、删除）都要求 Bearer 令牌；令牌用 `timingSafeEqual` 比较；`/api/health` 只返回 `{ ok: true }`。令牌通过 `Authorization` 头传递，不放在 URL 或 Cookie 中。
4. **P0-4 PDF.js 漏洞**：升级到 `pdfjs-dist@^6.4.299`（高于修复版本 `6.2.108`），显式关闭 `enableScripting` 和 XFA，保留严格 CSP，内容响应加 `sandbox` CSP。
5. **P0-5 资源耗尽**：文档总数、每 IP 文档数、并发流、上游超时、完整响应大小、创建/内容/删除请求速率均有上限；文档 TTL 默认缩短到 30 分钟；不再有临时镜像磁盘写入。
6. **P1-1 Host 头 / DNS rebinding**：新增 Host 白名单中间件，不匹配返回 421；未配置时只接受回环主机名；`HOST` 绑定非回环地址时必须显式设置 `ALLOWED_HOSTS`，否则拒绝启动。
7. **P1-2 信息泄露**：文档响应只保留 UI 必需字段，不再返回 owner IP、上游 URL、绝对路径、ETag/Last-Modified、配额等内部信息；远端错误不再回显上游状态码、主机/端口或压缩算法；所有 API 与错误响应带 `Cache-Control: no-store`。
8. **P1-3 自动打开**：`?path=`、`?url=`、`?open=` 已在前后端彻底移除，打开文档只能由表单提交或“最近打开”点击触发，并加入静态回归测试。
9. **P2-1 安全响应头**：补齐 HSTS（可选）、COOP/CORP、Permissions-Policy、`X-Permitted-Cross-Domain-Policies`、`X-DNS-Prefetch-Control`、`Origin-Agent-Cluster`、`form-action 'self'`；`/content` 使用 `sandbox` CSP 与 `private, no-store`。
10. **P2-2 目录链接协议白名单**：PDF outline 链接只允许 `http:` / `https:` / `mailto:`，拒绝 `javascript:`、`data:`、`file:`、自定义协议和 URL 内嵌凭据，并保留 `noopener,noreferrer`。
11. **P2-3 CSRF/Origin**：状态变更接口校验 `Origin` 与 `Sec-Fetch-Site`，默认只接受同源；独立前端需配置 `ALLOWED_ORIGINS`。即使未来改用 Cookie 会话，也不会立刻变成 CSRF 目标。
12. **P2-4 临时镜像清理**：当前版本不再落盘；启动时额外清理旧版本遗留的 `stream-pdf-*` 目录（仅本应用前缀、超过 24 小时、真实目录、不跟随符号链接）。
13. **P2-5 文件名/路径加固**：文件名与显示文本移除控制字符和 Unicode 双向覆盖字符，限制长度，处理 Windows 保留字符；本地路径模式已不存在，Windows 路径比较问题失效。
14. **P3 持续加固**：结构化 JSON 日志自动脱敏（token/URL query/绝对路径/控制字符）、`X-Request-Id`、可选的认证指标接口与周期快照、CI 依赖审计与 Dependabot、`SECURITY.md`、`.gitignore` 密钥规则、systemd/nginx/Docker 加固模板；非回环绑定强制显式 `AUTH_TOKEN`，非交互随机令牌写入 `0600` 文件而非日志。

部署建议：

- 公网部署可保持 `HOST=127.0.0.1` 并在前面放反向代理，或设置 `HOST=0.0.0.0` + `ALLOWED_HOSTS` + `AUTH_TOKEN` 监听；让代理传递原始 `Host`。
- 始终设置强随机 `AUTH_TOKEN`，不要通过 URL 传递令牌；生产环境不要依赖自动生成的随机令牌。
- 默认策略只允许公网目标；如部署在可信内网且必须访问私网/宿主 PDF 源，显式设置 `ALLOW_PRIVATE_ADDRESSES=1`，并配合网络层访问控制。
- 在主机/容器/防火墙层按需限制出站流量；应用层地址策略不能替代网络层控制。
- 使用 [deploy/streampdf.service](deploy/streampdf.service)、[deploy/nginx.conf](deploy/nginx.conf)、[deploy/docker-compose.yml](deploy/docker-compose.yml) 作为加固起点。[deploy/nginx.conf](deploy/nginx.conf) 是站点级 drop-in：放进 `conf.d`（或 Debian 系的 `sites-available`/`sites-enabled`）即可与同机其它站点共存；需要 80 -> 443 跳转时再加 [deploy/nginx-http-redirect.conf](deploy/nginx-http-redirect.conf)。
- 监控 401/429/5xx、文档数、活动连接、上游失败率；可开启 `ENABLE_METRICS=1` 或采集 JSON 日志中的 `metrics.snapshot`。
- 完整威胁模型、漏洞上报方式和公网部署清单见 [SECURITY.md](SECURITY.md)。


## 已知限制

- 远端必须支持 Range；不支持 Range 的 PDF 无法流式打开。
- 对于超过 10,000 页的 PDF，PDF.js 官方 viewer 会自动切换为单页滚动模式以控制内存。
- 超大页面在极高缩放比下受 `maxCanvasPixels` 限制，画布分辨率会自动封顶。
- PDF.js 在取页时会预取页树根节点的直接子节点。极少数拥有巨大“扁平页树”、且页面对象分散在 GB 文件各处的 PDF，首次打开可能读取较多页字典；正常的平衡页树文档不受影响。
- 需要支持 ES modules、WebAssembly 与现代 Canvas API 的浏览器（近期 Chrome / Edge / Firefox / Safari）。

## License

本项目使用 MIT License。渲染引擎 [PDF.js](https://github.com/mozilla/pdf.js) 使用 Apache-2.0 License，HTTP 框架 [Express](https://expressjs.com/) 使用 MIT License。
