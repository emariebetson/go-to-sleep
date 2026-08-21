FROM node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
WORKDIR /app
COPY services/readiness-gateway/package.json services/readiness-gateway/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY services/readiness-decision/src ./services/readiness-decision/src
COPY services/readiness-gateway/src ./services/readiness-gateway/src
USER node
CMD ["./node_modules/.bin/tsx", "services/readiness-gateway/src/runtime.ts"]
