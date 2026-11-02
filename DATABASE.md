# 本机执行服务与Docker业务数据库

当前正式架构：Mac运行Node管理页、任务守护、抖音浏览器、模型调用和视频制作；Docker只运行PostgreSQL 17，业务数据持久化到命名卷`database-data`。管理入口仍为`http://127.0.0.1:3146`，数据库端口默认只发布在本机`15432`。

| 数据 | 保存位置 |
| --- | --- |
| 私信/群聊快照、发送去重、评论记录 | PostgreSQL数据卷 |
| 长期记忆、费用与预算占用、待审记录 | PostgreSQL数据卷 |
| 兴趣、公开日报JSON、发布日账、节目回访 | PostgreSQL数据卷 |
| API密钥、管理员凭证、浏览器和Codex登录资料 | Mac私有目录 |
| 视频、音频、图片、采集缓存、Markdown导出 | Mac原专用目录 |
| 进程PID、Mac守护目标、运行告警和服务日志 | Mac运行目录 |

业务记录使用PostgreSQL事务保存原始JSON结构，保留字段顺序及审批哈希；通过版本校验拒绝旧实例覆盖新记录。统一存储层没有把每次访问变成Docker命令，也不依赖宿主机直接挂载Docker命名卷。数据库连接由本机工作线程管理。

## 检查与启动

Mac重启后优先双击`启动抖音助手.command`或运行`npm run start:local`。此入口按依赖顺序恢复已有环境，不运行setup/migrate，不创建第二个发送实例，保留暂停与普通浏览器后台运行。详见[START-LOCAL.md](START-LOCAL.md)。

```sh
npm run storage:status
npm run status:background
docker compose ps
```

`writerPresent:true`表示数据库中已有这个账号的执行锁；`lease`只表示检查命令本身是否持锁，普通只读检查为false是正常的。

未准备数据库的新安装可先运行：

```sh
npm run storage:setup
```

此命令创建本机私有连接/密码文件，并启动`database`服务；只做准备，不切换现有业务数据源。密码文件及连接文件为0600，不输出密码，也不包含在源码或镜像中。`DOUYIN_DATABASE_PORT`可指定其他本机端口。

## 迁移与切换

迁移需要原账号已绑定，并暂停所有写入：先停止worker并保留专用浏览器，再停止管理服务和LaunchAgent。`storage:migrate`会检查进程状态和独占执行锁；目标空间必须为空或是同一份已确认迁移，不能覆盖已有业务记录。

```sh
node scripts/background.mjs stop --maintenance --keep-browser
node scripts/dashboard.mjs stop --maintenance
node scripts/supervisor.mjs uninstall
npm run storage:migrate
```

完成后按迁移前的运行目标恢复服务；原来人工暂停的worker保持暂停。恢复LaunchAgent使用`npm run service:install`。迁移会先备份所有业务JSON，导入后逐份核对SHA-256，再创建`storage.json`绑定；旧JSON移至`storage-legacy/<迁移ID>/`，不再作为当前数据源。私有配置、登录态和媒体路径保持Mac原路径。

重复迁移不会重新发送旧消息。`sent/accepted/uncertain/publishing/published/scheduled`等状态及去重ID都按原样保留。迁移过程的数据库导入是一笔事务，未完成的导入回滚；确认结果不明时只能恢复同一迁移，不能当作空库重新覆盖。

## 数据服务故障

Docker停止、连接失效、账本丢失或校验失败时，相关处理停止并保留输入。守护提示数据库不可用，恢复后再重新核对。已经绑定数据库的运行目录不会自动回退旧JSON或空账本；删除/损坏绑定文件也不会启用旧副本。

同账号的执行进程须取得PostgreSQL会话级执行锁，另一个目录或进程无法同时取得。失去该连接后，旧实例不能继续提交发送状态。发送前已记为`sending`但结果未确认的记录，恢复时进入`uncertain`，不自动重发。

## 备份与导出

```sh
npm run storage:export -- /一个不存在的绝对路径/业务备份
```

导出是数据库的一致性只读快照，文件为私有权限，不包含API密钥或登录资料。现有控制台加密备份也会包含`database-state.json`业务快照；恢复旧备份只归档该快照，不覆盖当前数据库的发送账本，避免回滚去重状态。原始迁移前备份位于`storage-backups/<迁移ID>/`。

数据卷独立于容器生命周期；不要执行`docker compose down -v`删除它。本机连接凭证、备份恢复密钥和媒体目录也应单独保存。Docker Desktop仍在这台Mac上，运行助手需要Mac与Docker数据服务都保持可用。按用户后续授权，迁移前的`storage-backups`和`storage-legacy`明文副本已清理，保留两份通过校验的加密数据库备份。

## 本机切换记录 · 2026-11-02

27份正式业务记录已导入并逐份核对。原消息、评论和已发布记录完整保留，4份配置/凭证文件字节一致。Mac后台已恢复，并持有唯一数据库执行锁。旧完整Docker助手容器已停止并移除；后续授权清理中，确认无独有业务记录后，旧`assistant-data`卷及闲置助手镜像也已移除。当前正常Compose启动只运行数据库，完整助手代码仅保留在历史profile中。

参考：[PostgreSQL锁](https://www.postgresql.org/docs/17/explicit-locking.html)、[Docker数据卷](https://docs.docker.com/engine/storage/volumes/)。
