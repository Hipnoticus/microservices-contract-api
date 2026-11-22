# Stage 1: Build
FROM oven/bun:slim AS build
WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun run build

# Stage 2: Production
FROM oven/bun:slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY --from=build /build/dist ./dist
USER bun
EXPOSE 3002
CMD ["bun", "run", "dist/main.js"]
