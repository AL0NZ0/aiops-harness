# syntax=docker/dockerfile:1

# 构建阶段：把 TypeScript 编译成 JS，运行镜像不带 tsx 和源码工具链。
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}"
COPY tsconfig.json tsconfig.build.json ./
COPY api ./api
COPY extensions ./extensions
RUN npm run build

# 运行阶段：只保留生产依赖，非 root，根文件系统可只读挂载。
FROM node:22-bookworm-slim AS runtime
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
ENV NODE_ENV=production \
    AIOPS_HOST=0.0.0.0 \
    AIOPS_WEB_ROOT=/app/web \
    AIOPS_OPENAPI_FILE=/app/docs/openapi.json

RUN groupadd -g 10001 aiops \
  && useradd -u 10001 -g aiops -M -d /app -s /usr/sbin/nologin aiops

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}" && npm cache clean --force

COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 config ./config
COPY --chown=10001:10001 web ./web
COPY --chown=10001:10001 docs/openapi.json ./docs/openapi.json
COPY --chown=10001:10001 extensions/aiops-skills ./extensions/aiops-skills
COPY --chown=10001:10001 extensions/knowledge/fixtures ./extensions/knowledge/fixtures
RUN mkdir -p /app/data && chown 10001:10001 /app/data

USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AIOPS_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api/src/main.js"]