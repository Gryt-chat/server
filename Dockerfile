FROM oven/bun:1-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json bun.lockb* ./
COPY node_modules ./node_modules
RUN bun install

COPY . .
RUN bun run build

FROM oven/bun:1-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json bun.lockb* ./
COPY node_modules ./node_modules
RUN bun install --production

FROM oven/bun:1-alpine

RUN addgroup -g 1001 -S gryt \
  && adduser -S gryt -u 1001 -G gryt -h /app -s /sbin/nologin

WORKDIR /app
ARG VERSION=1.0.0
ENV NODE_ENV=production SERVER_VERSION=${VERSION}

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/package.json ./package.json
COPY --from=builder --chown=gryt:gryt /app/dist ./dist
COPY --from=builder --chown=gryt:gryt /app/public ./public

USER gryt
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["bun", "dist/index.js"]
