# syntax=docker/dockerfile:1.7
# Harness DVO service image. Pin NODE_IMAGE by digest in production (see configs/runtime-lock.yaml).
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ── build: compile every workspace package to dist/ ──────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
RUN npm ci --no-audit --no-fund
RUN npm run build

# ── runtime: production dependencies + compiled output only ───────────────────────
FROM ${NODE_IMAGE} AS runtime
# Optionally bake the pinned DeepSeek Harness launcher into the image (design §8.3).
ARG INSTALL_DSH=false
ARG DSH_VERSION=0.2.0-rc.1
ENV NODE_ENV=production \
    HARNESS_CONFIG_DIR=/app/configs \
    HARNESS_HTTP_HOST=0.0.0.0 \
    HARNESS_HTTP_PORT=8080
WORKDIR /app
RUN if [ "$INSTALL_DSH" = "true" ]; then npm install --global --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"; fi
COPY package.json package-lock.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/examples ./examples
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY configs ./configs
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 8080
VOLUME ["/app/.data"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HARNESS_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/service/dist/main.js"]
