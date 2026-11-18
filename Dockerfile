FROM node:22-alpine
WORKDIR /app
COPY package.json server.js defaults.js ./
COPY public ./public
ENV DATA_DIR=/data PORT=3000 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
