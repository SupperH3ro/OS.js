FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

COPY src/packages/JabyTheme/package.json src/packages/JabyTheme/
RUN cd src/packages/JabyTheme && npm install --no-audit --no-fund

COPY . .

RUN cd src/packages/JabyTheme && npm run build \
    && cd /app \
    && npm run package:discover \
    && npm run build

RUN mkdir -p vfs/jaby/.desktop \
    && printf '{"shortcuts":[]}\n' > vfs/jaby/.desktop/.shortcuts.json


FROM node:20-slim AS runtime

WORKDIR /app

COPY --from=builder /app /app

EXPOSE 8000

# Entrypoint: discover apps from Docker socket → generate iframe packages →
# re-run package discover (symlinks new apps into dist/) → serve.
CMD ["sh", "-c", "node scripts/discover-apps.js --force; node scripts/build-apps.js; npx osjs-cli package:discover; npm run serve"]
