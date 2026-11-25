# 历史静态界面部署说明

当前方案不再推进GitHub Pages或`gh-pages`部署，由Mac上的Node提供管理页面与API，Docker只负责业务数据库。已有远程仓库和已发布站点保留，不自动删除。

同域页面自动连接当前部署地址，支持本机、局域网IP和配置的域名，不再根据域名判断为GitHub页面。管理服务地址仍可配置，当前架构见[DATABASE.md](DATABASE.md)。正式入口为`http://127.0.0.1:3146`；旧Docker管理入口3147已退役。

## 允许界面来源

以下仅用于页面与API分开部署的兼容场景，来源不包含路径：

```bash
node scripts/dashboard-pages.mjs allow https://dashboard.example.com
node scripts/dashboard-pages.mjs status
```

配置单独保存到运行目录的 `dashboard-origins.json`，默认不允许跨站连接。可用 `remove` 撤销来源。

网页通过短期 Bearer 会话连接本机，不依赖跨站 Cookie。密码不保存到网页存储，模型密钥不交给前端。图片和视频通过认证请求生成浏览器内存 Blob，下载也走认证接口，会话令牌不放在链接参数里。

## 构建静态文件

```bash
npm --prefix web/cult ci
node scripts/build-pages.mjs --out .pages-dist
```

输出必须使用空目录。构建包只收集界面、公共角色与品牌图片、字体和静态说明，不收集运行目录、配置、聊天、凭证或浏览器资料。此兼容脚本只生成独立静态文件，不执行提交、推送或GitHub部署。独立页面可填写自己的HTTP/HTTPS API地址，服务器仍需明确允许对应来源。

本机原管理入口仍可通过 `http://127.0.0.1:3146` 使用，管理员密码和模型配置共用同一份本机记录。
