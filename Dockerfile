FROM node:22-alpine
WORKDIR /app
# dependências (só o driver do Postgres, "pg")
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# todos os módulos .js da raiz (server, auth, store, community, sources, images, share…)
COPY *.js ./
COPY public ./public
COPY catalog ./catalog
# Com DATABASE_URL definido, tudo vai para o Postgres e /data não é usado.
ENV NODE_ENV=production DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
