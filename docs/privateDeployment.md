# 私有服务器部署

本部署使用 fork 中的源码，前端在本机 `npm ci && npm run generate`，服务器仅安装后端依赖并运行。保留 `tsx` 开发依赖，或自行改用经过验证的编译产物。

后端环境变量：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=5679
HUOBAO_DATA_DIR=/var/lib/huobao
SQLITE_PATH=/var/lib/huobao/huobao.sqlite3
WORKSPACE_PATH=/var/lib/huobao/workspace
FRONTEND_DIST=/opt/manju/huobao/frontend/.output/public
FFMPEG_BIN=/usr/bin/ffmpeg
FFPROBE_BIN=/usr/bin/ffprobe
```

首次部署将 `backend/workspace` 复制到持久目录，运行用户应只有自身数据目录的写入权限。使用独立的非 root 系统用户、systemd 自动重启和内存限额；应用源码只读。不要将密钥、数据库或生成素材提交到 Git。

## 普通网页登录

应用经 HTTPS 反向代理和共享 `webAuth` 服务访问，使用页面上的账号密码表单登录，不使用浏览器 BasicAuth 弹窗。认证覆盖**整个应用站点**，包含 API、SSE、上传和 `/static/*`，不得为健康检查或媒体公开例外。应用后端及认证服务均只监听回环地址。

请求路径：

```text
浏览器 → HTTPS Caddy
  /auth/login、/auth/logout、/auth/session → webAuth（127.0.0.1:3080）
  其他路径 → forward_auth /internal/verify → 火宝（127.0.0.1:5679）
```

`/internal/verify` 仅供 Caddy 内部调用，不作为公网认证旁路。Caddy 固定注入站点标识、主机名、协议和客户端地址，不信任浏览器传入的同名请求头；同时限制跨来源写入，并继续禁用应用内自动更新接口。完整模板见 [`deployment/webAuth/Caddyfile.example`](../deployment/webAuth/Caddyfile.example)，部署时应同时修改模板和认证配置中的域名。

两站共用认证服务和账号，Cookie 与会话各自绑定站点；在一站登录或退出不会自动改变另一站的会话。这不是跨域单点登录。

### 认证服务

- 实现：[`deployment/webAuth/server.mjs`](../deployment/webAuth/server.mjs)，使用 Node.js 内置模块，无新增应用依赖。
- systemd 单元：[`deployment/webAuth/manjuAuth.service`](../deployment/webAuth/manjuAuth.service)，独立系统用户 `manjuauth`，监听 `127.0.0.1:3080`。
- `AUTH_CONFIG_FILE=/etc/manju-auth/config.json`：用户名、scrypt 盐与密码哈希、允许的站点域名；不保存明文密码，不提交此文件到 Git。
- `AUTH_DATA_DIR=/var/lib/manju-auth`：持久化会话，目录权限 `0700`、会话文件 `0600`，应用数据目录与该服务隔离。
- 登录成功签发 `__Host-manjuSession`，有效期 7 天，带 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，不设置 `Domain`。服务器存储令牌摘要；重新登录会轮换旧会话，退出立即撤销当前会话。
- 登录表单校验 CSRF Cookie、同源 Origin，并限制密码尝试频率；登录回跳仅允许安全的本站相对路径。认证失败不返回 `WWW-Authenticate`。

### 前端契约

| 请求 | 行为 |
| --- | --- |
| `GET /auth/login?next=...` | 显示普通登录表单；`next` 由服务端校验。 |
| `POST /auth/login` | 提交用户名、密码、CSRF 和 `next`；成功后设置 Cookie，以 303 返回原页面。 |
| `GET /auth/session` | 已登录返回 200 和 `{ "authenticated": true, "user": "..." }`；未登录返回 401 和 `authenticated: false`。 |
| `POST /auth/logout` | 浏览器同源请求自动携带 Cookie 与 Origin；成功撤销会话、清除 Cookie，返回 204。 |
| 未登录的受保护 API | 返回 401 和 `error_code: "loginRequired"`，不会触发浏览器密码弹窗。 |
| 未登录的页面导航 | 303 跳转 `/auth/login`，保留安全的当前相对路径以便登录后返回。 |

火宝通过真实 `/auth/session` 响应决定是否显示右上角用户名和“退出登录”。桌面版跳过探测；未部署网关的开发环境不显示无效的退出入口。退出成功后进入登录页。

API 客户端只有收到 **HTTP 401 且 `error_code` 为 `loginRequired`** 才跳转登录。上游模型密钥错误属于应用配置错误（例如 HTTP 400 携带 `apiKeyInvalid`），不能使用户退出网页登录。登录密码与 AI API Key 是不同凭据。

应用中的 AI 配置接口会返回已保存的模型密钥，因此不能只保护首页。更新接口仍由代理禁用，以便通过 fork 的代码发布。

### 验证与发布

在本机运行认证服务的实际 HTTP 回归：

```sh
node deployment/webAuth/server.test.mjs
```

该脚本使用临时目录与专用本地账号，检查登录、Cookie 属性、CSRF、跨站会话隔离、重启后会话保留、会话轮换、退出、过期、安全回跳和限频；不要使用生产凭据运行测试。

发布前另用全新浏览器会话验证：匿名深链接进入登录页、登录回到原页面、刷新保持登录、右上角退出后 API 重新拒绝访问。只更新登录入口等前端功能时，可替换 `frontend/.output/public` 静态产物，无须重启正在执行生成任务的应用后端。

## 模型及素材

文本生成选择 `gpt-6.1-terra` 或 `gpt-6-luna` 时固定关闭推理：Chat Completions 发送 `reasoning_effort: "none"`，Responses 发送 `reasoning: { effort: "none" }`。该规则在 SDK 序列化及通用中转补丁之后执行，不受 `AI_DISABLE_THINKING` 或 `AI_THINKING_OFF_PATCH` 覆盖。官方接口会将这两个模型的显示名（如 `GPT-6 Luna`）转换为标准模型 ID；中转接口保留原模型 ID。其他文字模型沿用已有策略。

官方 GPT-6.1 Terra 的工具调用使用 Responses，Luna 保留 Chat Completions，参见 [OpenAI 参数与工具兼容说明](https://developers.openai.com/api/docs/guides/latest-model)。请求序列化回归可运行 `cd backend && node node_modules/tsx/dist/cli.mjs --test tests/text-model-reasoning.test.ts`，不访问外部模型服务。

在设置中填写自己的 AI API。不要设置 `PUBLIC_BASE_URL` 指向需要登录的素材入口：部分模型会主动从 URL 拉取视频或音频参考，无法通过浏览器登录。当前图片的 base64 路径可用；需要远程拉取的媒体引用需另行提供受控、短期有效的地址。不要为此公开整个素材目录。

前端构建、后端类型检查和实际 HTTP 验证通过不代表已验证所有模型的付费生成。

## Muse 视频排队

`openai` 配置中的 `muse-video` 使用数据库保存的本地队列，按任务 ID 顺序逐个提交。等待的任务显示“本地排队中”，不占用 Muse 的浏览器队列；其他视频模型沿用原来的调度方式。该队列用于单个火宝后端进程，部署时不要运行多个共享数据库的实例。

重启后继续处理本地队列；已经取得上游任务 ID 的任务只查询原任务，不重新提交。排队期间仍使用创建任务时的配置 ID 和服务地址，配置被删除或地址变化时停止该任务，避免误发给其他服务。

提交超时或连续查询失败不能证明上游已经停止生成。这类任务显示“上游状态待确认”，会暂停后续 Muse 视频提交，并禁止直接删除以绕过保护。有上游 ID 时可恢复查询；没有 ID 时需先人工核对上游。已确认生成失败的任务可直接点击“重新生成”，无需先恢复旧任务或重复确认；按钮旁提示新任务可能消耗额度。`force_new` 不能绕过状态未确认或仍在运行的任务。

Muse2API 的 `video_text_only`、`model_refusal` 等明确失败保留原错误分类；`generation_unknown` 保持待确认，不放行后续生成。上游在同一任务中自动补试时，火宝显示“上游自动重试中”，继续查询原任务，不另发生成请求。恢复查询与下载不会重新计费。

队列只协调本火宝实例的请求。其他客户端共享同一 Muse 服务时仍会占用其生成槽位。
