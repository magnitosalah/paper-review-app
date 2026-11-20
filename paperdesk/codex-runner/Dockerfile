FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.146.0
RUN npm install --global @openai/codex@${CODEX_VERSION}
WORKDIR /app
COPY --chown=node:node package.json server.mjs codex.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 CODEX_RUNNER_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.mjs"]
