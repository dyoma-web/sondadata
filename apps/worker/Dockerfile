# Worker de SondaData — para Railway / Fly.io / cualquier host de contenedores.
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/engine/package.json packages/engine/
COPY packages/fixtures/package.json packages/fixtures/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @sondadata/worker...

COPY packages/schema packages/schema
COPY packages/engine packages/engine
COPY packages/fixtures packages/fixtures
COPY apps/worker apps/worker

ENV NODE_ENV=production
ENV PORT=8787
# SONDADATA_SECRET_KEY y SONDADATA_DATA_DIR se inyectan en el despliegue.
EXPOSE 8787
CMD ["pnpm", "--filter", "@sondadata/worker", "dev"]
