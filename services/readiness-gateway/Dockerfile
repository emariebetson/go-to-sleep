FROM node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
RUN npm install --global tsx@4.22.1
WORKDIR /app
COPY services/readiness-decision/src ./services/readiness-decision/src
COPY services/readiness-gateway/src ./services/readiness-gateway/src
USER node
CMD ["tsx", "services/readiness-gateway/src/runtime.ts"]
