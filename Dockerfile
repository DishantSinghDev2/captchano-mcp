# CaptchaNo MCP server
# Default: stdio transport (what Glama and most MCP hosts expect):
#   docker run -i --rm -e CAPTCHANO_API_KEY=cn-... captchano-mcp
# Streamable HTTP instead:
#   docker run --rm -p 8080:8080 -e CAPTCHANO_API_KEY=cn-... -e CAPTCHANO_MCP_HTTP_TOKEN=change-me \
#     captchano-mcp --http --host 0.0.0.0 --port 8080

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
