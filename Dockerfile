FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
# No npm install: the application has no runtime dependencies.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY findings.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
