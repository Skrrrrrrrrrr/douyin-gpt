# Docker 数据服务

当前采用 **Mac运行助手和浏览器，Docker运行PostgreSQL，业务数据存数据卷** 的架构。

- 管理页面及Node服务：`http://127.0.0.1:3146`。
- 数据库：Compose的`database`服务，默认仅本机`15432`端口。
- 业务数据卷：`database-data`；密钥、登录资料和媒体继续留在Mac。
- 旧完整助手容器已退役，`3147`管理页与`6080`浏览器桌面不再作为正式入口。

准备、迁移、故障处理和备份见[DATABASE.md](DATABASE.md)。通过域名或局域网访问Mac管理页仍可配置`DOUYIN_DASHBOARD_HOST`和`DOUYIN_DASHBOARD_URL`，保留管理员认证和明确来源校验。

```sh
npm run storage:status
docker compose ps
```

默认Compose只启动数据库。历史完整助手在`legacy-assistant` profile内，仅供明确的离线恢复参考，不应与正式Mac后台同时启用发送；旧数据卷保留，不能作为当前账本继续写入。

<details>
<summary>历史完整容器部署记录（已退役，不是当前操作步骤）</summary>

# Docker 运行

容器包括 Node 后台、管理网页、普通 Chromium 虚拟桌面、Python/FFmpeg、中文字体和 Codex CLI。Mac 上不会弹出容器浏览器窗口；扫码和平台验证在网页桌面中由本人完成。Docker Desktop 仍运行在这台 Mac 上，关机或停止 Docker 后容器也会停止；迁移到云服务器运行才可以独立于 Mac。

```sh
docker compose build
docker compose up -d
docker compose ps
```

默认管理页为 <http://127.0.0.1:3147>，浏览器桌面为 <http://127.0.0.1:6080/vnc.html>。发布地址和端口均可配置，不依赖GitHub Pages。Node在容器内直接监听配置的接口，不再通过仅限loopback的转发桥接。桌面密码保存在容器的 `/data/desktop/vnc-password.txt`；管理页沿用导入的管理员密码，未导入时会创建独立初始密码文件，首次登录需修改。原生VNC和浏览器调试端口仍不发布。

所有运行记录、凭据、登录态、媒体、输出和 Codex 授权保存在 `assistant-data` 数据卷。重建容器保留数据；不要使用 `docker compose down -v`，它会删除数据卷。镜像仅包含源码与公共素材，不包含本机聊天、API 密钥或登录态。

## 使用局域网地址或域名

从其他设备访问管理页时，配置Compose发布地址；页面和API同域时直接使用当前访问地址，不需要填写另一台设备的localhost：

```sh
DOUYIN_DASHBOARD_BIND=0.0.0.0 docker compose up -d
```

随后访问`http://运行Docker的主机IP:3147`，仍需管理员登录。浏览器桌面可独立设置`DOUYIN_DESKTOP_BIND`与`DOUYIN_DESKTOP_PORT`；它保留自己的桌面密码。

域名或反向代理部署应配置对外来源，代理须保留原Host：

```sh
DOUYIN_DASHBOARD_BIND=0.0.0.0 \
DOUYIN_DASHBOARD_URL=https://assistant.example.com \
docker compose up -d
```

`DOUYIN_DASHBOARD_PORT`可改变宿主机发布端口，容器内部仍为3147；改变外部端口时，同时用`DOUYIN_DASHBOARD_URL`填写含新端口的实际来源地址。公开来源支持HTTP/HTTPS、域名及IPv4/IPv6，不包含子路径、用户密码、查询参数或通配符。公网使用HTTPS；服务依据配置的公开来源设置Secure会话Cookie，不盲目信任转发头。

只有独立静态页面与API分开部署时才需要额外配置跨域来源；来源逐项明确允许，仍使用管理员登录及独立Bearer会话。默认不向任意网页开放CORS。

## 从当前 Mac 复制数据

导入只能写入空数据卷，源目录只读挂载。导入保留账号、联系人范围、模型选择、配额、双角色记忆、费用和发送账本；媒体路径改为容器路径。Mac 浏览器资料不能直接作为 Linux 浏览器登录态使用，因此不复制 `browser/`，需要在容器重新登录原账号。源数据不变。

```sh
export DOUYIN_IMPORT_DIR='/绝对路径/douyin-gpt-runtime'
export DOUYIN_IMPORT_VIDEOS='/绝对路径/douyin-videos'
export DOUYIN_IMPORT_LOGS='/绝对路径/douyin-daily-logs'
export DOUYIN_IMPORT_ROOT='/绝对路径/douyin-gpt'
docker compose -f compose.yaml -f compose.import.yaml run --rm --no-deps \
  --entrypoint sh assistant -c 'node docker/import.mjs && chown -R 1000:1000 /data'
docker compose up -d
```

旧 Mac 加密备份放入 `/data/imported-macos-backups/`，保留原恢复密钥，避免用包含 Mac 路径的旧配置覆盖容器配置；新的容器备份继续使用 `backups/`。

导入的是一个时间点的副本。Mac 后台继续运行时，源数据可能继续变化。因此首次启动容器的自动 worker 默认暂停，晚报调度也不执行。不能在两处同时启动同一个抖音号的自动发送。

## 登录及正式切换

1. 在浏览器桌面完成抖音登录，随后核对仍是原绑定账号。验证码只能由本人处理。
2. 视频理解的 Codex CLI 使用数据卷中的授权，保持原模型。已有本机文件式 CLI 授权时可单独复制至 `/data/codex/auth.json` 并设置所属用户及 `0600` 权限；本次部署已复用现有 ChatGPT 文件式授权，未读取 Mac 钥匙串，也没有改用 API 密钥计费。没有缓存时，通过以下命令登录原 ChatGPT 账号：

   ```sh
   docker compose exec assistant codex login --device-auth
   docker compose exec assistant codex login status
   ```

3. 正式切换前停止 Mac 对应助手及其自动恢复，确认没有制作、发布或发送在途，再补齐导入之后的账本变化。保留所有 `sent/accepted/published/scheduled/uncertain/publishing` 等状态，不把未知结果当作未发送重试。
4. 核对容器的数据、账号和模型授权后，再在容器管理页明确启动后台。不要仅因为容器显示 healthy 就认定自动回复已经启用；healthy 只验证管理页、桌面和容器进程。

本机守护与容器完全独立。本部署不会自动停止或改变正在使用的 Mac 运行目录。初次导入记录中的 `liveCutoverComplete:false` 表示尚未完成正式切换。

## 检查和备份

```sh
docker compose logs --tail=60 assistant
docker compose exec assistant node scripts/background.mjs status
docker compose exec assistant node docker/healthcheck.mjs
docker compose exec assistant /opt/venv/bin/python -m pip check
docker compose stop
```

项目原自动备份只含部分配置、公开日报和日志。完整迁移/灾备需要在停止容器后备份整个数据卷，并把加密材料与恢复密钥另存到安全位置。

浏览器在容器的普通 X11 虚拟桌面中运行；Chrome 自身的命名空间沙箱不可用，启动器使用 Docker 隔离与非 root 用户运行。容器不挂载 Docker socket、Mac 用户目录或 Mac 浏览器配置。

参考：[Docker 数据卷](https://docs.docker.com/engine/storage/volumes/)、[Codex CLI](https://learn.chatgpt.com/docs/cli)、[Codex 登录](https://learn.chatgpt.com/docs/auth?surface=cli)。

## 本机部署核验 · 2026-11-02

- 已构建 Linux ARM64 镜像并启动容器，管理端口 `3147` 与浏览器桌面端口 `6080` 仅本机可访问。
- 已复制1751个文件、约500 MB的运行记录和媒体至独立数据卷；原目录只读导入，保留绑定账号和回复范围，旧浏览器资料没有迁移。
- 8项迁移/暂停回归通过；实际容器通过中文字体、FFmpeg H.264/AAC、Python配音库、Codex CLI参数、数据格式与镜像隐私边界检查。
- 实际重启后，数据卷标记保留，管理页和桌面健康检查通过，自动worker保持暂停。Codex本地登录状态已核对为ChatGPT授权。
- 尚需本人在容器浏览器登录原抖音号并核对；当前 `liveCutoverComplete:false`。这是隔离副本，尚未停止Mac后台或正式接管刷视频、发信及发布调度，也未用真实私信或公开评论做发送测试。

</details>
