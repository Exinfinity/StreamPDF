# StreamPDF

用 Node.js 作为后端、PDF.js 作为渲染引擎的流式 PDF 预览器。输入**公网 HTTP(S) PDF 直链**，即可在浏览器中按需加载、平滑浏览 GB 级 PDF。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-2f8f5b)
![PDF.js](https://img.shields.io/badge/PDF.js-6.4-7c5cff)
![License](https://img.shields.io/badge/license-MIT-blue)

> **安全模型变更**：服务器端本地文件读取（路径模式）已完全移除。StreamPDF 只通过 HTTP(S) 从远端加载 PDF，不再接受任何服务器文件路径。所有 `/api/*` 文档接口都需要 Bearer 访问令牌。

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

不设置 `AUTH_TOKEN` 时，服务会在每次启动时生成一个随机令牌并打印到终端。打开终端中输出的地址：

```text
http://127.0.0.1:3000
```

页面会要求输入访问令牌。输入终端打印的令牌（或你设置的 `AUTH_TOKEN`）后：

1. 粘贴 PDF 直链，例如 `https://example.com/files/manual.pdf`。
2. 回车或点击“打开文档”。

> URL 由 **Node 服务端**请求，因此目标地址必须能从服务器访问，并且必须是公网 HTTP(S) 地址。本机、内网、链路本地和云元数据地址会被拒绝。

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
| `AUTH_TOKEN` | 随机生成 | 访问令牌，至少 16 个可打印非空格字符。未设置时启动时随机生成并打印 |
| `MAX_DOCUMENTS` | `100` | 全局文档会话数上限，超过返回 503 |
| `MAX_DOCUMENTS_PER_IP` | `5` | 每个客户端 IP 的文档会话数上限，超过返回 429 |
| `MAX_REMOTE_BYTES` | `2147483648`（2 GiB） | 单次内容响应的最大字节数（无 Range 的完整响应，或覆盖整个文件的单个 Range 请求）；超限中止连接 |
| `DOCUMENT_TTL_MINUTES` | `30` | 文档会话闲置过期时间（分钟） |
| `MAX_CONCURRENT_STREAMS` | `100` | 同时进行的内容流上限，超过返回 503 |
| `ALLOWED_REMOTE_PORTS` | `80,443` | 允许访问的远端端口，逗号分隔 |
| `TRUST_PROXY` | 空 | 设为 `1` 时信任一层反向代理的 `X-Forwarded-For`，用于按真实客户端 IP 计算配额/限流。仅在应用只接受可信代理连接时启用 |
| `REMOTE_HEADERS_TIMEOUT_MS` | `20000` | 连接远端、等待响应头的超时 |
| `REMOTE_BODY_IDLE_TIMEOUT_MS` | `30000` | 读取远端响应体时的空闲超时 |
| `ENABLE_HSTS` | 空 | 设为 `1` 时发送 HSTS 头；仅在 HTTPS 反向代理后启用 |

示例：

```bash
AUTH_TOKEN='a-very-long-random-token' \
MAX_DOCUMENTS=50 \
MAX_DOCUMENTS_PER_IP=3 \
ALLOWED_REMOTE_PORTS=443 \
PORT=8080 \
npm start
```

文档创建、内容读取和删除接口还有进程内每 IP 限流：创建默认 10 次/分钟、内容读取 600 次/分钟、删除 30 次/分钟。连续失败的认证尝试默认限制为 10 次/分钟。`MAX_CONCURRENT_STREAMS` 默认 100；浏览器通常每个源只并发数个请求，普通预览不会触及上限；如果使用非浏览器客户端并一次发起大量并发 Range 请求，可能收到 503，可按需调高。公网部署时仍建议在反向代理层再配置 `limit_req` / `limit_conn`。

## 远端 URL 的行为

标准静态文件服务器、对象存储、CDN 通常都支持 Range，可以直接流式打开。

**远端必须支持 Range。** 如果远端忽略 `Range` 并返回 `200`，服务端会拒绝打开（`REMOTE_NO_RANGE`），不会把文件下载到服务器磁盘或内存中缓存。这是为了保持“只通过 HTTP 按需加载”的安全模型，并避免磁盘/内存耗尽。

以下情况无法打开：

- 登录态/签名链接、需要 Cookie 或特殊请求头的地址；
- 返回 HTML 网页而不是 PDF 文件本身；
- 强制压缩传输（`Content-Encoding: gzip` 等）的地址，字节范围语义不可靠；
- 不支持 Range 的地址；
- 本机、内网、链路本地、云元数据地址，以及非 80/443 端口（可通过 `ALLOWED_REMOTE_PORTS` 调整）。

加密 PDF 会在浏览器中弹出密码输入框；密码只在当前内存中的 PDF.js 实例里使用，不会发送给服务端。

## 开发与测试

```bash
npm run dev    # Node --watch 模式
npm test       # 认证、SSRF、Range 代理、限流、资源上限等测试
```

测试覆盖：

- 未认证/错误令牌访问文档 API 返回 401；
- 本地路径模式被拒绝（`LOCAL_FILES_DISABLED`）；
- 回环、私网、链路本地、云元数据、IPv4 编码、IPv4-mapped IPv6、NAT64、6to4 等 SSRF 目标被拒绝；
- 非 HTTP(S) 协议、URL 内嵌凭据、非白名单端口被拒绝；
- 重定向逐跳重新校验；
- 远端 PDF 的精确 Range 响应、`206`、`416`、`HEAD`；
- 不支持 Range 的远端被明确拒绝；
- 全局/每 IP 文档数、创建限流、上游超时、无 Range 响应大小上限；
- `pdfjs-dist` 版本高于 CVE 影响范围，且前端显式 `enableScripting: false`。

也可以自行启动一个支持 Range 的测试 HTTP 服务来发送 `test-pdf/` 下的文件（该目录已被 `.gitignore` 忽略，不会进入仓库）。

## 项目结构

```text
.
├── server/
│   ├── index.js        # 启动、环境变量、优雅退出
│   ├── app.js          # Express 路由、认证、Range 响应、安全头、限流
│   ├── auth.js         # Bearer 令牌生成与常量时间校验
│   ├── http-client.js  # SSRF 防护、DNS pinning、重定向校验、超时
│   ├── documents.js    # 文档会话、统计、TTL/数量/每 IP 配额
│   ├── rate-limit.js   # 进程内每 IP 固定窗口限流
│   ├── sources.js      # 远端 URL 探测、Range 代理
│   ├── range.js        # Range 头解析
│   └── errors.js       # 统一错误
├── public/
│   ├── index.html      # 工作台 + 官方 PDF.js 查看器容器 + 访问令牌对话框
│   ├── styles.css      # UI、响应式布局、页面样式
│   └── js/app.js       # PDF.js 初始化、认证、打开流程、目录、统计、交互
├── scripts/
│   ├── make-sample-pdf.mjs     # 多页、带填充数据的普通测试文件
│   └── make-gb-sample-pdf.mjs  # 稀疏写入的约 1 GB 流式测试文件
├── test/
└── package.json
```

PDF.js 直接从 `node_modules/pdfjs-dist` 提供静态资源，由 `/vendor/pdfjs/*` 映射，无需打包器。

## 安全说明

本轮修复针对 `SECURITY-AUDIT.md` 的 5 个 P0 问题：

1. **P0-1 本地文件读取（LFI）**：彻底移除 `source: "path"`、`PDF_ALLOWED_ROOTS`、本地文件探测与读取。服务端不再接受客户端提供的任何文件系统路径。
2. **P0-2 SSRF**：只允许公网 HTTP(S) 地址；解析并校验全部 DNS 结果，拒绝回环/私网/链路本地/CGNAT/保留地址、IPv4-mapped IPv6、NAT64、6to4、Teredo；连接时 pin 住已校验 IP 防 DNS rebinding；手动处理最多 3 跳重定向并逐跳重新校验；禁止 URL 内嵌凭据；默认只允许 80/443；设置连接/响应头/响应体空闲超时。
3. **P0-3 无认证**：所有文档接口（包括 `/api/config`、内容、统计、删除）都要求 Bearer 令牌；令牌用 `timingSafeEqual` 比较；`/api/health` 只返回 `{ ok: true }`。令牌通过 `Authorization` 头传递，不放在 URL 或 Cookie 中。
4. **P0-4 PDF.js 漏洞**：升级到 `pdfjs-dist@^6.4.299`（高于修复版本 `6.2.108`），显式关闭 `enableScripting` 和 XFA，保留严格 CSP，内容响应加 `sandbox` CSP。
5. **P0-5 资源耗尽**：文档总数、每 IP 文档数、并发流、上游超时、完整响应大小、创建/内容/删除请求速率均有上限；文档 TTL 默认缩短到 30 分钟；不再有临时镜像磁盘写入。

部署建议：

- 保持 `HOST=127.0.0.1`，前面使用 nginx/Caddy 终止 TLS 并做认证/限流。
- 始终设置强随机 `AUTH_TOKEN`，不要通过 URL 传递令牌。
- 在主机/容器/防火墙层限制出站流量，禁止到 RFC1918、`169.254.0.0/16`、本机的出站访问。
- 不要为了访问内网 PDF 而放宽 SSRF 校验；本项目按“只允许公网 URL”设计。
- 监控 401/429/5xx、文档数、活动连接和上游失败率。

## 已知限制

- 浏览器无法从 `<input type=file>` 获得真实绝对路径；本项目也不再支持服务器本地路径或文件上传。
- 远端必须支持 Range；不支持 Range 的 PDF 无法流式打开。
- 对于超过 10,000 页的 PDF，PDF.js 官方 viewer 会自动切换为单页滚动模式以控制内存。
- 超大页面在极高缩放比下受 `maxCanvasPixels` 限制，画布分辨率会自动封顶。
- PDF.js 在取页时会预取页树根节点的直接子节点。极少数拥有巨大“扁平页树”、且页面对象分散在 GB 文件各处的 PDF，首次打开可能读取较多页字典；正常的平衡页树文档不受影响。
- 需要支持 ES modules、WebAssembly 与现代 Canvas API 的浏览器（近期 Chrome / Edge / Firefox / Safari）。

## License

本项目使用 MIT License。渲染引擎 [PDF.js](https://github.com/mozilla/pdf.js) 使用 Apache-2.0 License，HTTP 框架 [Express](https://expressjs.com/) 使用 MIT License。
