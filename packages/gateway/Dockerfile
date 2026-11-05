# An ABX FS gateway in a container. Build from the REPOSITORY ROOT:
#
#   docker build -f packages/gateway/Dockerfile -t abxfs-gateway .
#   docker run --rm -p 8080:8080 -e ABXFS_RPC_URL_<chainId>=https://… abxfs-gateway --content-domain content.example --chains <network>
#
# The mirror ships in the same image:
#
#   docker run --rm -v "$PWD/data:/data" --entrypoint node abxfs-gateway dist/bin/mirror.js \
#     --chain <network> --provider local --endpoint http://host.docker.internal:5001 \
#     --cursor /data/cursor.json
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@artblocks/abxfs-gateway..."
RUN pnpm --filter "@artblocks/abxfs-gateway..." build
# `--legacy`: pnpm 10 otherwise requires `inject-workspace-packages`, which this repo does not set.
RUN pnpm --filter @artblocks/abxfs-gateway deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out /app
USER node
# 0.0.0.0 because a container is only reachable on its own interface; publish the port deliberately.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "dist/bin/gateway.js"]
