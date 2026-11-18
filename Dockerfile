# otoroshi-api-management — one image, started with a list of roles (APIM_ROLES)
FROM oven/bun:1.3.11 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
RUN bun run build

FROM oven/bun:1.3.11
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server ./server
COPY cli ./cli
COPY --from=build /app/dist ./dist
EXPOSE 9000
CMD ["bun", "server/main.js"]
