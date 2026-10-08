FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
ENV PORT=8787 DB_PATH=/data/predmon.db
EXPOSE 8787
CMD ["node","server/index.mjs"]
