# StreamPDF

用 Node.js 作为后端、PDF.js 作为渲染引擎的流式 PDF 预览器。输入**本地文件路径**或**网络 URL**，即可在浏览器中按需加载、平滑浏览 GB 级 PDF。

![StreamPDF 首页](docs/landing.png)

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-2f8f5b)
![PDF.js](https://img.shields.io/badge/PDF.js-5.7-7c5cff)
![License](https://img.shields.io/badge/license-MIT-blue)

## 为什么大文件也能快速打开

普通 PDF 预览方案往往先把整个文件下载进内存，再交给渲染器。一个 1.8 GB 的文件意味着数秒到数分钟的等待，以及随时可能触发的内存溢出。

StreamPDF 把“加载 PDF”拆成按需的 HTTP Range 请求：

```text
浏览器 PDF.js
   │  1. 需要文件头 /  xref / 某个页面对象
   ▼
GET /api/documents/:id/content
Range: bytes=1048576-2097151
   │
   ├─ 本地文档：fs.createReadStream(path, { start, end })
   └─ 远程文档：Node fetch 转发 Range，不落盘、不整体缓存
   ▼
206 Partial Content
Content-Range: bytes 1048576-2097151/1932735283
```

- **本地文件零拷贝**：Node 只打开文件并读取请求的字节范围，不把 PDF 读进进程内存。
- **远端 URL 代理**：解决浏览器跨域限制；远端支持 Range 时逐块转发。
- **PDF.js 严格按需**：`disableAutoFetch` + `disableStream` + 1 MiB `rangeChunkSize`，只取当前需要的分片。
- **页面虚拟化**：使用 PDF.js 官方 `PDFViewer` 渲染队列，只为视口附近的页面创建画布，离开视口的画布会被回收。
- **内存占用与文件大小解耦**：打开 2 GB 文件并不比打开 20 MB 文件多占用 2 GB 内存。

侧栏会实时显示服务器实际传输的字节数、Range 请求次数和当前连接状态，方便确认文档并没有被整体下载。

## 快速开始

环境要求：Node.js 20 或更高版本。

```bash
npm install
npm start
```

打开终端中输出的地址：

```text
http://127.0.0.1:3000
```

然后：

1. 选择“本地文件路径”，输入服务器所在系统可访问的绝对路径，例如：
   - Linux / macOS：`/home/me/books/manual.pdf`
   - Windows：`D:\docs\manual.pdf`
   - 也支持 `~/Downloads/manual.pdf`
2. 或选择“网络 URL”，粘贴 PDF 直链，例如 `https://example.com/files/manual.pdf`。
3. 回车或点击“打开文档”。

> 路径是由 **Node 服务端**读取的，不是浏览器读取的。因此输入的是运行 `npm start` 那台机器上的路径。

### 生成测试 PDF

仓库附带一个多页、带填充数据的大文件生成脚本：

```bash
# 输出到 test-output/streampdf-sample.pdf，300 页，约 12 MB
npm run sample

# 自定义：输出路径、页数、填充 MB 数
node scripts/make-sample-pdf.mjs test-output/big.pdf 1200 512
```

大填充数据是 PDF 中合法但未被页面引用的 stream，用来制造大文件并验证 Range 请求，不会明显拖慢单页渲染。

### 生成约 1 GB 的真实流式测试文件

```bash
# 默认：201 页、约 1 GB，页对象分散在填充空洞之间
npm run sample:gb

# 自定义：输出路径、页数、目标大小（MB）
node scripts/make-gb-sample-pdf.mjs test-output/huge.pdf 501 2048
```

这个生成器使用稀疏写入和平衡页树，不会把 1 GB 全放进 Node 内存。打开后跳到第 2 页或最后一页，侧栏的 Range 请求数和传输字节会明显增加，可以直接验证“只为当前页附近的字节付费”。注意：文件系统可能不会真正稀疏化磁盘空间，请预留足够空间。


## 实测大文件表现

在一个约 **1.0 GB、201 页**的本地测试 PDF 上（页面对象分散在填充空洞之间，使用平衡页树）：

| 操作 | 传输量 | Range 请求 | 说明 |
| --- | --- | --- | --- |
| 打开并渲染第一页 | 1.95 MB | 2 | 仅约文件的 0.2% |
| 跳到第 2 页 | +2.0 MB | +2 | 页码附近分片 |
| 跳到第 101 页（文件中部） | +6.0 MB | +6 | 累计仍只有 1.0% |

浏览器打开耗时约 2.6 秒，Node 服务进程不持有 PDF 内容缓存。不同设备、磁盘和网络环境会有差异，可用下方 `npm run sample:gb` 自行复现。

## 使用方式

- **最近打开**：成功的路径/URL 会保存在浏览器 `localStorage`，最多 6 条。
- **页码跳转**：工具栏页码输入框回车即可跳到任意页。
- **缩放 / 适应宽度 / 旋转**：工具栏按钮。
- **文档目录**：侧栏读取 PDF outline，点击可跳转；最多展示 2500 项以防止超长目录拖慢界面。
- **实时传输统计**：每 1.5 秒读取一次服务端 Range 统计。
- **快捷打开**：`Ctrl/Cmd + O`。
- **URL 参数直接打开**：
  - `?path=/absolute/path/book.pdf`
  - `?url=https://example.com/book.pdf`
  - `?open=...`（按内容自动判断路径/URL）

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。局域网访问可设为 `0.0.0.0`，但请先阅读安全说明 |
| `PDF_ALLOWED_ROOTS` | 空（不限制） | 允许读取的根目录，多个目录用系统路径分隔符分隔（Linux/macOS `:`，Windows `;`）。设置后只能打开这些目录下的文件 |
| `REMOTE_MIRROR_LIMIT_MB` | `64` | 远端不支持 Range 时，允许镜像到临时文件的大小上限（MB） |

示例：

```bash
PDF_ALLOWED_ROOTS=/data/pdfs:/home/me/books npm start
REMOTE_MIRROR_LIMIT_MB=128 PORT=8080 npm start
```

## 远端 URL 的行为

标准静态文件服务器、对象存储、CDN 通常都支持 Range，可以直接流式打开。

如果远端服务器忽略 `Range`：

- 文件不超过 `REMOTE_MIRROR_LIMIT_MB`：服务端会一次性下载到系统临时目录，再按 Range 提供。该流程**不是流式**，会等待下载完成；临时文件会在文档关闭或会话过期后清理。
- 文件超过上限：拒绝打开，并提示改用支持 Range 的直链或下载到本地。

以下情况需要先下载到本地：

- 登录态/签名链接、需要 Cookie 或特殊请求头的地址；
- 返回 HTML 网页而不是 PDF 文件本身；
- 强制压缩传输（`Content-Encoding: gzip` 等）的地址，字节范围语义不可靠；
- 明确禁止 Range 且文件很大的服务。

加密 PDF 会在浏览器中弹出密码输入框；密码只在当前内存中的 PDF.js 实例里使用，不会发送给服务端。

## 开发与测试

```bash
npm run dev    # Node --watch 模式
npm test       # Range 解析、本地分片、远程代理、远程镜像等测试

node scripts/make-sample-pdf.mjs
npm start
# 打开 http://127.0.0.1:3000?path=.../test-output/streampdf-sample.pdf
```

测试覆盖：

- RFC 7233 单段 Range 解析（闭区间、开放区间、后缀、越界）；
- 本地 PDF 的精确字节响应、`206`、`416`、`HEAD`；
- 服务端远程 Range 代理转发；
- 远端不支持 Range 时的小文件镜像；
- 超出镜像上限的明确拒绝；
- 非 PDF 文件和不存在路径的错误响应。

## 项目结构

```text
.
├── server/
│   ├── index.js        # 启动、环境变量、优雅退出
│   ├── app.js          # Express 路由、Range 响应、安全头
│   ├── documents.js    # 文档会话、统计、TTL 清理
│   ├── sources.js      # 本地文件与远端 URL 探测、Range 代理/镜像
│   ├── range.js        # Range 头解析
│   └── errors.js       # 统一错误
├── public/
│   ├── index.html      # 工作台 + 官方 PDF.js 查看器容器
│   ├── styles.css      # UI、响应式布局、页面样式
│   └── js/app.js       # PDF.js 初始化、打开流程、目录、统计、交互
├── scripts/
│   ├── make-sample-pdf.mjs     # 多页、带填充数据的普通测试文件
│   └── make-gb-sample-pdf.mjs  # 稀疏写入的约 1 GB 流式测试文件
├── test/
└── package.json
```

PDF.js 直接从 `node_modules/pdfjs-dist` 提供静态资源，由 `/vendor/pdfjs/*` 映射，无需打包器。

## 实现要点与取舍

### 为什么使用官方 PDFViewer 而不是手写 canvas 列表

PDF.js 的 `PDFViewer` 实现了成熟的渲染队列、可见页检测、页面缓存回收、文本层和注释层。大文件最怕的是“把所有页都渲染成 canvas”，官方 viewer 默认只保留约 10 个页面画布，适合数百到数千页文档。在此基础上，我们额外用 `disableAutoFetch` 阻止 PDF.js 预取整个文件。

### 为什么 `disableStream: true`

PDF.js 检测到服务器支持 Range 时，会先发一个不带 Range 的 GET。禁用流式模式后，它会在拿到响应头后取消这个完整请求，转而只用 Range 分片，避免大文件在后台被持续下载。服务端的连接关闭处理会立即停止对应文件流。

### 内存策略

- 服务端：无 PDF 内容缓存，只有文件描述符和 256 KiB 读取缓冲。
- 浏览器：PDF.js 页面画布缓存 + 当前页文本/注释层。
- 远端镜像仅用于小文件，并写入临时目录，不占用 Node 堆内存。

### 统计口径

侧栏显示的“已传输”是服务端通过 Range 响应实际写出的字节数。初始探测请求、被取消的完整请求和 PDF.js 后续分片都会计入，因此它反映真实网络开销，而不是 PDF.js 解析进度。探测请求在取消前可能已经传了一部分字节，所以小文件上“已传输”偶尔会达到文件大小的 100% 以上；界面会将百分比封顶并标注“含探测”。

## 安全说明

这是一个本地工具，默认只监听 `127.0.0.1`：

- 任意本地文件路径都可能被读取，建议在共享机器上设置 `PDF_ALLOWED_ROOTS`。
- 远端 URL 由服务端代理，存在 SSRF 风险；如果要暴露到公网，必须增加 URL 白名单、认证和网络出站限制。
- 文档会话使用随机 UUID 令牌，不能通过路径猜测；令牌默认在闲置 12 小时后失效。
- 不要把 `HOST` 设置为 `0.0.0.0` 后直接暴露到不可信网络。

## 已知限制

- 浏览器无法从 `<input type=file>` 获得真实绝对路径，所以本项目的“本地文件”是通过服务端路径读取，而不是上传文件。
- 对于超过 10,000 页的 PDF，PDF.js 官方 viewer 会自动切换为单页滚动模式以控制内存。
- 超大页面在极高缩放比下受 `maxCanvasPixels` 限制，画布分辨率会自动封顶。
- 远端不支持 Range 且文件超过镜像上限时无法流式打开，这是 HTTP 语义限制，不是前端优化可以绕过的。
- PDF.js 在取页时会预取页树根节点的直接子节点。极少数拥有巨大“扁平页树”、且页面对象分散在 GB 文件各处的 PDF，首次打开可能读取较多页字典；正常的平衡页树文档不受影响。
- 需要支持 ES modules、WebAssembly 与现代 Canvas API 的浏览器（近期 Chrome / Edge / Firefox / Safari）。

## License

本项目使用 MIT License。渲染引擎 [PDF.js](https://github.com/mozilla/pdf.js) 使用 Apache-2.0 License，HTTP 框架 [Express](https://expressjs.com/) 使用 MIT License。
