# syntax=docker/dockerfile:1

# ---------- 依赖安装 ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

# ---------- 构建前后端 ----------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ---------- 运行时 ----------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    SERVE_STATIC=true \
    DATABASE_FILE=/data/inkpane.sqlite

WORKDIR /app

# 只安装运行时依赖；前后端构建产物从 build 阶段复制
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# SQLite 数据目录，配合 docker-compose 的具名卷使用
RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 4000

CMD ["node", "server/dist/index.js"]
