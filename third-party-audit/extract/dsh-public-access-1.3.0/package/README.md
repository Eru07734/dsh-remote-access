# dsh-public-access

DeepSeek Harness 反向代理插件 — 支持公网 IP / nginx 访问 + 登录认证。

## 📖 简介

`dsh-public-access` 是一个 DeepSeek Harness 插件，用于将本地开发环境暴露到公网或局域网，同时提供安全的登录认证机制。该插件解决了以下核心问题：

- **网络绑定**：将 DSH Web 服务绑定到 `0.0.0.0`，支持公网 IP 和局域网访问
- **安全认证**：提供登录页面和会话管理，防止未授权访问
- **API 代理**：自动重写请求头，绕过特权接口的 localhost 限制
- **前端兼容**：注入 polyfill 脚本，确保在公网 HTTP 环境下的功能完整性

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 **全接口绑定** | 通过自定义 `web-startup` 解除 dsh 对 `--host 0.0.0.0` 的安全限制，绑定全部接口 |
| 🔐 **登录认证** | 在 dsh 0.1.x 浏览器令牌鉴权之上叠加用户名/密码登录，会话有效期 24 小时（两种鉴权并存） |
| 🛡️ **信任栅栏** | 通过 `--trusted-host` 声明公网/LAN IP，绑定 `0.0.0.0` 时 dsh 自动派生 LAN 可信主机 |
| 🖥️ **前端兼容** | 注入 `__DSH_TRANSPORT__.ownsHost`，使公网访问获得回环级 `isLoopback` 状态 |
| 🔒 **crypto polyfill** | 公网 HTTP 环境支持 `crypto.randomUUID` 等 Web Crypto API |
| 🚀 **自动检测** | 启动时自动检测公网 IP 和局域网 IP，自动配置 trusted-hosts |

## 📦 安装

### 方式一：通过 DSH 插件管理器安装（推荐）

```bash
dsh plugin --profile web add dsh-public-access
```

### 方式二：手动安装

```bash
# 克隆仓库
git clone https://gitee.com/jn-qq/dsh-public-access.git
cd dsh-public-access

# 安装依赖
npm install

# 链接到全局
npm link
```

## 🚀 使用方法

### 快速启动

```bash
# 使用默认账号 admin/admin
./start.sh

# 或者直接使用 dsh 命令
dsh --profile web --no-open
```

### 自定义配置启动

```bash
# 自定义账号密码
DSH_AUTH_USER=myuser DSH_AUTH_PASS=mypassword ./start.sh

# 自定义端口
DSH_PORT=8080 ./start.sh

# 组合配置
DSH_AUTH_USER=admin DSH_AUTH_PASS=secure123 DSH_PORT=8080 ./start.sh
```

### 生产环境部署

```bash
# 使用 systemd 服务（推荐）
sudo tee /etc/systemd/system/dsh.service <<EOF
[Unit]
Description=DeepSeek Harness with Public Access
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/dsh-public-access
Environment=DSH_AUTH_USER=admin
Environment=DSH_AUTH_PASS=your-secure-password
Environment=DSH_PORT=3080
ExecStart=/path/to/dsh-public-access/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable dsh
sudo systemctl start dsh
```

## ⚙️ 配置选项

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DSH_AUTH_USER` | `admin` | 登录用户名 |
| `DSH_AUTH_PASS` | `admin` | 登录密码 |
| `DSH_AUTH_SALT` | `dsh-reverse-proxy-salt` | 密码哈希盐值 |
| `DSH_PORT` | `3080` | 监听端口 |

### 命令行参数

| 参数 | 说明 |
|------|------|
| `--host <host>` | 指定绑定主机地址 |
| `--port <port>` | 指定监听端口（0 表示自动选择） |
| `--no-open` | 不自动打开浏览器 |
| `--trusted-host <authority>` | 添加额外的 trusted-host（可重复使用） |

## 🔧 与 nginx 配合使用

### 基本配置

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### HTTPS 配置

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

## 🔒 安全说明

### 认证机制（dsh 0.1.x 适配）

dsh 0.1.x 引入了浏览器令牌鉴权：每个进程生成一个随机启动令牌，访问 `http://<host>:<port>/?token=...` 后换取绑定该 authority 的签名 Cookie（默认 30 天有效）。本插件在该机制**之上**叠加用户名/密码登录，两种鉴权并存：

- **插件登录（推荐，便于多人共享）**：访问根路径未登录时跳转 `/_auth/login`，使用 `DSH_AUTH_USER` / `DSH_AUTH_PASS` 登录，签发 24 小时有效的 `dsh_session` Cookie。
- **dsh 令牌（备选）**：启动时控制台打印的 `?token=...` URL 仍可直接使用，换取 dsh 原生签名 Cookie。
- **信任栅栏**：`/api` 请求需通过 dsh 的 Host/Origin 校验——本插件通过 `--trusted-host` 声明公网/LAN IP，绑定 `0.0.0.0` 时 dsh 还会自动派生 LAN IPv4 为可信主机。
- **会话管理**：插件令牌使用 HMAC-SHA256 签名；密码使用 SHA-256 加盐哈希；比较使用 `timingSafeEqual` 防止时序攻击。
- **前端兼容**：注入脚本设置 `globalThis.__DSH_TRANSPORT__.ownsHost = true`，使公网访问获得与回环一致的 `isLoopback` 状态（主机设置持久化、文件打开等功能可用）；并补齐公网 HTTP 下的 Web Crypto polyfill。

### 安全建议

1. **修改默认密码**：生产环境务必修改默认的 `admin/admin` 凭据
2. **使用 HTTPS**：通过 nginx 配置 SSL 证书
3. **限制访问**：使用防火墙限制访问来源 IP
4. **定期更新**：保持插件版本更新以获取安全修复

## 🛠️ 故障排除

### 常见问题

#### 1. 无法访问 Web 界面

```bash
# 检查服务是否运行
ps aux | grep dsh

# 检查端口是否监听
netstat -tlnp | grep 3080

# 检查防火墙设置
sudo ufw status
sudo iptables -L -n
```

#### 2. 登录后自动跳转回登录页

```bash
# 检查浏览器是否禁用 Cookie
# 检查系统时间是否准确（会话验证依赖时间戳）
date

# 清除浏览器缓存和 Cookie
```

#### 3. API 请求返回 401

```bash
# 确保已登录且会话未过期
# 检查请求是否携带正确的 Cookie
curl -v -b "dsh_session=your-session" http://localhost:3080/api/status
```

#### 4. nginx 代理后 WebSocket 连接失败

确保 nginx 配置包含 WebSocket 支持：
```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### 日志查看

```bash
# 查看 DSH 日志
journalctl -u dsh -f

# 或直接查看进程输出
./start.sh 2>&1 | tee dsh.log
```

## 📁 项目结构

```
dsh-public-access/
├── src/
│   ├── reverse-proxy-fix.js  # 主插件逻辑（登录路由 + 鉴权适配 + polyfill）
│   ├── auth.js               # 认证模块（会话管理、密码验证、登录页面）
│   └── web-startup.js        # Web 启动配置（解除 0.0.0.0 限制、解析命令行参数）
├── cordis.patch.yml          # DSH 插件配置补丁
├── start.sh                  # 启动脚本
├── package.json              # 包配置
└── README.md                 # 说明文档
```

## 🤝 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### 开发环境

```bash
# 克隆仓库
git clone https://gitee.com/jn-qq/dsh-public-access.git
cd dsh-public-access

# 安装依赖
npm install

# 链接到本地 DSH 开发环境
npm link
```

### 代码规范

- 使用 ES Module 语法
- 遵循现有代码风格
- 添加必要的注释
- 更新相关文档

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 🔗 相关链接

- **仓库地址**：https://gitee.com/jn-qq/dsh-public-access.git
- **DeepSeek Harness**：https://github.com/deepseek-ai/dsh
- **问题反馈**：https://gitee.com/jn-qq/dsh-public-access/issues

## 📞 支持

如有问题或建议，请通过以下方式联系：

- 提交 Issue 到 Gitee 仓库
- 发送邮件至维护者

---

**享受使用 DeepSeek Harness 的愉快体验！** 🎉
