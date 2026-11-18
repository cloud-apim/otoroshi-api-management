# otoroshi-api-management — one image, one executable (server/bin.js, compiled): the server with
# the roles of APIM_ROLES by default, `setup` for the gateway, or any command of the cli.
#
#   docker build -t otoroshi-api-management .
#   docker buildx build --platform linux/amd64,linux/arm64 -t … .   the executable cross-compiled

# the executable is compiled on the platform of the build, for the platform of the image
FROM --platform=$BUILDPLATFORM oven/bun:1.3.11 AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
COPY server ./server
COPY cli ./cli
COPY scripts/build-binary.js ./scripts/build-binary.js
RUN bun run build \
 && case "${TARGETARCH:-}" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      "") target= ;; \
      *) echo "unsupported architecture ${TARGETARCH}" && exit 1 ;; \
    esac \
 && bun scripts/build-binary.js ${target:+--target $target} \
 && mv dist/bin/otoroshi-apim* /otoroshi-apim

# a slim system: git for the git remote catalogs, the certificates of the https calls, no bun,
# no node_modules — the executable carries the runtime, the console and the portal
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /home/apim --create-home apim
COPY --from=build /otoroshi-apim /usr/local/bin/otoroshi-apim
USER apim
WORKDIR /home/apim
ENV NODE_ENV=production
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD ["otoroshi-apim", "health"]
ENTRYPOINT ["otoroshi-apim"]
CMD ["serve"]
