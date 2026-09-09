# syntax=docker/dockerfile:1
ARG REGISTRY=docker.io
FROM ${REGISTRY}/library/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc
WORKDIR /build
COPY package.json .npmrc tsconfig.json ./
COPY src src
RUN npm ci --no-audit --strict-ssl=false && npm run build
FROM ${REGISTRY}/library/alpine:3.24
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates nodejs
COPY --from=build /build/dist /app/dist
WORKDIR /app
EXPOSE 8080
CMD ["node", "dist/index.js"]
