FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="Aliyun Panel" \
      org.opencontainers.image.description="Self-hosted Alibaba Cloud ECS management and traffic protection" \
      org.opencontainers.image.source="https://github.com/haoch1/aliyun-panel" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4182 DATA_DIR=/app/data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/package.json /app/LICENSE ./
RUN mkdir /app/data && chown node:node /app/data \
    && chmod 755 /app/bin/aliyun-panel.mjs \
    && ln -s /app/bin/aliyun-panel.mjs /usr/local/bin/aliyun-panel
USER node
VOLUME /app/data
EXPOSE 4182
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["aliyun-panel", "--healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT []
CMD ["aliyun-panel"]
