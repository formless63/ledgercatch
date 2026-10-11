FROM oven/bun:1.4.2 AS build
WORKDIR /app
ENV NITRO_PRESET=node-server
ARG VITE_APP_NAME=LedgerCatch
ENV VITE_APP_NAME=$VITE_APP_NAME
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Release preparation builds the extension once; every consumer uses these bytes.
RUN test -s public/downloads/ledgercatch-extension.zip \
 && cd public/downloads && sha256sum -c SHA256SUMS
RUN bun run build && bun scripts/bundle-runtime.ts

FROM node:24.21.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.txt ./
COPY --chown=node:node scripts/start.mjs ./scripts/start.mjs
RUN npm install --omit=dev --no-save --no-package-lock pdfjs-dist@6.4.299 tesseract.js@7.0.0 \
 && mkdir -p /app/tessdata \
 && wget -qO /app/tessdata/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz \
 && echo "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91  /app/tessdata/eng.traineddata.gz" | sha256sum -c - \
 && chown -R node:node /app/node_modules /app/tessdata
ENV OCR_LANG_PATH=/app/tessdata OCR_ALLOW_DOWNLOAD=false
USER node
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
