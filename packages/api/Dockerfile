FROM node:20-alpine
WORKDIR /repo

# Workspace-aware install: copy only the manifests + shared/api source so
# Docker layer caching survives unrelated changes to worker/frontend.
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api

RUN npm install
RUN npm run build

WORKDIR /repo/packages/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
