FROM node:22.22.2-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

FROM dependencies AS build

COPY app ./app
COPY scripts ./scripts
COPY demo-corpus ./demo-corpus
COPY react-router.config.ts tsconfig.json vite.config.ts ./

RUN npm run build

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev

FROM node:22.22.2-bookworm-slim AS runtime

WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/app ./app
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/demo-corpus ./demo-corpus
COPY package.json react-router.config.ts tsconfig.json vite.config.ts ./

RUN find /app -path /app/node_modules -prune -o -type f \( -name "*.md" -o -name ".env" -o -name ".env.*" \) -delete

EXPOSE 3000

ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD ["npm", "run", "start"]
