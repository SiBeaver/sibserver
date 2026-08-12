# === build: install deps + compile all packages ===
# Build context: vibesrcs/sibeaver/
FROM node:22-alpine AS build
ARG http_proxy
ARG https_proxy
RUN apk add --no-cache python3 make g++ && corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /app

# Layer 1: package manifests → pnpm install (cached by lockfile)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/webui/package.json packages/webui/
RUN pnpm install --frozen-lockfile

# Layer 2: source → build all packages
COPY packages/ packages/
RUN pnpm -r build

# === sibs: API server runtime ===
FROM node:22-alpine AS sibs
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/server/dist /app/dist
ENV NODE_ENV=production PORT=7420
EXPOSE 7420
CMD ["node", "/app/dist/api/server.js"]

# === sibs-web: frontend static server runtime ===
FROM node:22-alpine AS sibs-web
WORKDIR /app
COPY --from=build /app/packages/webui/dist/ /app/web/
EXPOSE 80
CMD ["node", "-e", "const{createServer}=require('http');const{readFile}=require('fs/promises');const{join}=require('path');const m={'html':'text/html','js':'application/javascript','css':'text/css','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};createServer(async(_,r)=>{try{const p=join('/app/web',_.url==='/'?'/index.html':_.url);const c=await readFile(p);const e=p.split('.').pop();r.writeHead(200,{'Content-Type':m[e]||'application/octet-stream'});r.end(c)}catch{r.writeHead(200,{'Content-Type':'text/html'});r.end(await readFile('/app/web/index.html'))}}).listen(80)"]
