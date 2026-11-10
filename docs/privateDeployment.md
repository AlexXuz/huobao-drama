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

## 登录保护

应用本身没有用户鉴权，必须经 HTTPS 反向代理访问。代理认证覆盖**整个站点**，包含 API、SSE、上传和 `/static/*`，不得为健康检查或媒体公开例外。后端只监听回环地址，外部只能经代理访问。

以 Caddy 2.6 为例（2.8 及以后将 `basicauth` 改为 `basic_auth`）：

```caddyfile
drama.example.com {
    basicauth {
        yourUser YOUR_BCRYPT_HASH
    }
    @crossOrigin {
        header Origin *
        not header Origin https://drama.example.com
    }
    respond @crossOrigin "Cross-origin requests are not allowed." 403
    @update path_regexp updates (?i)^/api/v1/server-update(/|$)
    respond @update "Updates are managed through server deployment." 403
    reverse_proxy 127.0.0.1:5679 {
        header_up -Authorization
        header_down Cache-Control "private, no-store"
        flush_interval -1
    }
}
```

密码使用 Caddy 的 `hash-password` 生成哈希，配置中不保存明文。应用中的 AI 配置接口会返回已保存的模型密钥，因此不能只保护首页。更新接口由代理禁用，以便通过 fork 的代码进行发布。

## 模型及素材

在设置中填写自己的 AI API。不要设置 `PUBLIC_BASE_URL` 指向需要登录的素材入口：部分模型会主动从 URL 拉取视频或音频参考，无法通过浏览器登录。当前图片的 base64 路径可用；需要远程拉取的媒体引用需另行提供受控、短期有效的地址。不要为此公开整个素材目录。

前端构建、后端类型检查和实际 HTTP 验证通过不代表已验证所有模型的付费生成。
