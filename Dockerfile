FROM node:22-alpine

WORKDIR /app
COPY DECLARATION.md ./
COPY signatures ./signatures
COPY scripts ./scripts
COPY site ./site

RUN node site/build.js

ENV PORT=8080
EXPOSE 8080
# Starts as root to chown the /data volume, then server.js drops to uid 1000.
CMD ["node", "site/server.js"]
