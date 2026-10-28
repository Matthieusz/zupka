# Build from the owner's configured checkout; no external configuration loader.
FROM node:26.12.1-bookworm-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @zupka/api deploy --legacy --prod --frozen-lockfile /runtime

FROM node:26.12.1-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 \
    DATABASE_PATH=/data/zupka.sqlite UPLOADS_PATH=/data/uploads
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3001
VOLUME ["/data"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.mjs"]
