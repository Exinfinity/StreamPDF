# StreamPDF hardened container image (P3).
#
# Build:
#   docker build -f deploy/Dockerfile -t streampdf:local .
#
# Run (the app refuses to start on a public bind without both secrets):
#   docker run --rm --init --read-only --tmpfs /tmp:size=64m \
#     --cap-drop ALL --security-opt no-new-privileges \
#     -p 127.0.0.1:3000:3000 \
#     -e HOST=0.0.0.0 \
#     -e ALLOWED_HOSTS=pdf.example.com \
#     -e AUTH_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")" \
#     streampdf:local
#
# Prefer deploy/docker-compose.yml, which wires the same hardening flags.

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
# --omit=dev keeps test-only tooling out of the runtime image; --ignore-scripts
# blocks install-time scripts from third-party packages.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

# The base image provides an unprivileged node user (uid 1000).
USER node

EXPOSE 3000

# Host 127.0.0.1 is always accepted by the application Host guard.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/index.js"]
