# Docker 部署与 OpenResty 公网访问

推荐结构：

```text
公网用户
   │ HTTPS 443
   ▼
OpenResty（宿主机）
   │ http://127.0.0.1:4000
   ▼
InkPane 容器（Node + Express + SQLite）
   │
   └── /data/inkpane.sqlite（Docker 具名卷 inkpane-data）
```

后端容器只绑定宿主机回环地址 `127.0.0.1:4000`，公网只开放 `80/443`，不要直接暴露 `4000`。

前置条件：服务器已安装 Docker Engine 和 Docker Compose v2（`docker compose version` 能正常输出）。
旧版只有 `docker-compose` 时，把下文的 `docker compose` 换成 `docker-compose` 即可。

## 1. 准备配置

```bash
cd website
cp server/.env.docker.example server/.env.docker
chmod 600 server/.env.docker
```

编辑 `server/.env.docker`，至少修改：

```dotenv
PUBLIC_ORIGIN=https://ink.example.com
CORS_ORIGIN=https://ink.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
SETUP_REQUIRE_CODE=true
# INKPANE_SETUP_CODE=换成随机字符串
```

如果暂时没有 HTTPS，先把 `COOKIE_SECURE` 改成 `false` 测试，正式上线再改回 `true`。

## 2. 构建并启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f inkpane
```

本机验证：

```bash
curl http://127.0.0.1:4000/api/health
```

应返回类似：

```json
{ "data": { "status": "ok", "env": "production", "schemaVersion": 4 } }
```

> 容器日志里的「设备端可填写」可能显示 Docker 内网 IP（如 `172.x.x.x`）。
> 公网部署时设备应填写 `https://ink.example.com`，不要使用容器内网地址。

## 3. 配置 OpenResty

复制示例配置：

```bash
sudo mkdir -p /usr/local/openresty/nginx/conf/conf.d
sudo cp deploy/openresty/inkpane.conf \
  /usr/local/openresty/nginx/conf/conf.d/inkpane.conf
```

编辑 `/usr/local/openresty/nginx/conf/conf.d/inkpane.conf`：

- 把 `ink.example.com` 改成你的域名
- 修改证书路径
- 确认 OpenResty 主配置的 `http {}` 中包含：

```nginx
include conf.d/*.conf;
```

检查并重载：

```bash
sudo /usr/local/openresty/nginx/sbin/nginx -t
sudo systemctl reload openresty
```

如果服务名不是 `openresty`，按实际名称调整，例如 `nginx`。

> 如果 OpenResty 本身也跑在 Docker 里，就不要使用 `127.0.0.1:4000` 端口映射。
> 让 OpenResty 容器和 InkPane 容器加入同一个 Docker network，
> 然后把 `proxy_pass` 改成 `http://inkpane:4000`。

## 4. 申请 HTTPS 证书

如果还没有证书，可以先用 HTTP-only 方式启动站点：

1. 临时注释掉配置里的整个 `listen 443` server 块
2. 检查并重载 OpenResty
3. 申请证书：

```bash
sudo apt install -y certbot
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d ink.example.com
```

4. 取消注释 443 server 块
5. 再次检查并重载：

```bash
sudo /usr/local/openresty/nginx/sbin/nginx -t
sudo systemctl reload openresty
```

建议添加续期后的自动重载钩子：

```bash
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-openresty.sh >/dev/null <<'EOF'
#!/bin/sh
/usr/local/openresty/nginx/sbin/nginx -t && systemctl reload openresty
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-openresty.sh
sudo certbot renew --dry-run
```

## 5. 首次初始化

浏览器打开：

```text
https://ink.example.com/setup
```

如果设置了 `INKPANE_SETUP_CODE`，输入该值；否则从容器日志里找一次性初始化码：

```bash
docker compose logs inkpane | grep -i setup
```

如果设置了 `INKPANE_ADMIN_USERNAME` / `INKPANE_ADMIN_PASSWORD`，可以直接打开：

```text
https://ink.example.com/login
```

## 6. 数据备份与恢复

SQLite 数据在具名卷 `inkpane-data` 的 `/data/inkpane.sqlite`。备份前先停容器：

```bash
mkdir -p backups
backup_dir="backups/inkpane-$(date +%F-%H%M)"
mkdir -p "$backup_dir"

docker compose stop inkpane
docker cp inkpane:/data/. "$backup_dir/"
docker compose start inkpane
```

恢复：

```bash
docker compose stop inkpane
docker run --rm \
  -v inkpane-data:/data \
  -v "$PWD/backups/inkpane-YYYY-MM-DD-HHMM:/backup:ro" \
  node:24-bookworm-slim \
  sh -c 'cp -a /backup/. /data/ && chown -R node:node /data'
docker compose start inkpane
```

## 7. 升级

```bash
cd website

# 先备份数据库
docker compose stop inkpane
backup_dir="backups/inkpane-$(date +%F-%H%M)"
mkdir -p "$backup_dir"
docker cp inkpane:/data/. "$backup_dir/"

git pull
docker compose up -d --build
docker compose logs -f inkpane
```

数据库迁移会在服务启动时自动执行。

## 8. 常用排查

### OpenResty 返回 502

```bash
curl http://127.0.0.1:4000/api/health
docker compose ps
docker compose logs --tail=100 inkpane
```

确认容器在运行，并且端口映射是 `127.0.0.1:4000:4000`。

### 登录后立刻掉线

- `COOKIE_SECURE=true` 时必须通过 HTTPS 访问
- `PUBLIC_ORIGIN` / `CORS_ORIGIN` 必须和浏览器地址完全一致
- 反向代理必须转发原始 `Host`，示例配置已经包含 `proxy_set_header Host $http_host;`

### 日志提示找不到 `web/dist`

重新构建：

```bash
docker compose up -d --build
```

### 初始化页无法创建管理员

检查：

```bash
docker compose logs inkpane | grep -i setup
```

确认 `SETUP_REQUIRE_CODE=true` 时输入了正确的初始化码。

## 9. 安全提醒

- 只对公网开放 `80/443`
- `4000` 仅绑定 `127.0.0.1`
- `server/.env.docker` 权限设为 `600`，不要提交到 Git
- 首次上线前设置 `SETUP_REQUIRE_CODE=true` 或预置管理员
- 当前限流和 SQLite 都是单机设计，不要直接横向扩容多实例
- 定期备份 `inkpane-data` 卷
