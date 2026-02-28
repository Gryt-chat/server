FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .
RUN bun run build && bun run bundle

FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
RUN npm init -y > /dev/null 2>&1 \
  && npm install better-sqlite3 sharp \
  && rm -f package.json package-lock.json

FROM node:22-alpine

RUN addgroup -g 1001 -S gryt \
  && adduser -S gryt -u 1001 -G gryt -h /app -s /sbin/nologin

WORKDIR /app
ARG VERSION=1.0.0
ENV NODE_ENV=production SERVER_VERSION=${VERSION}

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/dist/bundle.js ./bundle.js

USER gryt
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["node", "bundle.js"]
