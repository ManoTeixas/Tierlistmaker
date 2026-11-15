FROM node:22-alpine
WORKDIR /app
# todos os módulos .js da raiz (server, auth, community, sources, images, share…)
COPY package.json *.js ./
COPY public ./public
COPY catalog ./catalog
ENV NODE_ENV=production DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
