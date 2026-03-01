FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build && yarn bundle

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --production --ignore-engines --network-timeout 600000

FROM node:22-bookworm-slim

RUN groupadd -g 1001 gryt && useradd -m -u 1001 -g 1001 -d /app -s /usr/sbin/nologin gryt
WORKDIR /app

ARG VERSION=1.0.0
ENV NODE_ENV=production SERVER_VERSION=${VERSION}

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/dist/bundle.js ./bundle.js
COPY --from=builder --chown=gryt:gryt /app/dist/admin-setOwner.js ./admin-setOwner.js

RUN mkdir -p /data && chown -R gryt:gryt /data

USER gryt
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bundle.js"]