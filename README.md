# studio_aligned

独立应用（与旧版目录彻底分离）：

- 前端：React + React Router + MUI + Zustand + tldraw + Vite PWA
- 后端：FastAPI (`/api/v1/*`)

## 双击启动（推荐）

直接双击项目根目录下这个文件：

`start_studio.command`

如果你把项目挪了位置，脚本会自动向上查找包含 `backend` / `frontend` 的项目目录。

它会自动：
- 启动后端（`8899`）
- 启动前端（`5174`）
- 自动打开浏览器

## 1) 启动后端

```bash
cd <项目根目录>/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8899 --reload
```

## 2) 启动前端

```bash
cd <项目根目录>/frontend
npm install
npm run dev
```

前端默认端口：`5174`
后端默认端口：`8899`

如需修改 API 地址：

```bash
# frontend/.env.local
VITE_API_BASE_URL=http://127.0.0.1:8899
```

## GitHub Actions 自动部署（Aliyun）

本项目已内置：

- `docker-compose.yml`
- `backend/Dockerfile`
- `frontend/Dockerfile`
- `.github/workflows/deploy.yml`

### 1) GitHub Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 新建以下 `Repository secrets`：

- `SERVER_HOST`：服务器 IP 或域名
- `SERVER_PORT`：SSH 端口（通常 `22`）
- `SERVER_USER`：SSH 用户名（如 `root`）
- `DEPLOY_PATH`：服务器部署目录（如 `/opt/studio_aligned`）
- `DEPLOY_KEY`：私钥内容（用于 SSH）
- `RUNTIME_ENV`：运行环境变量内容（多行）
- `STUDIO_HTTP_API_KEY`：小豆包 API key（独立 secret，便于轮换）

`RUNTIME_ENV` 示例：

```env
BACKEND_PORT=8899
FRONTEND_PORT=5174
VITE_API_BASE_URL=
```

`STUDIO_HTTP_API_KEY` 请单独放到 GitHub Secret（不要写在 `RUNTIME_ENV` 里）。  
说明：当 `STUDIO_HTTP_API_KEY` 存在时，后端会优先使用该值，且设置接口不会返回明文 key。

### 2) 触发部署

推送到 `main` 分支后会自动执行部署；也可在 Actions 页面手动 `Run workflow`。

### 3) 服务器访问

- 前端：`http://<SERVER_HOST>:5174`
- 健康检查：`http://<SERVER_HOST>:5174/healthz`
