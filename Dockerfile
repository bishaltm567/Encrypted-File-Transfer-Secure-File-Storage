FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=10000 STORAGE_DIR=/app/storage
EXPOSE 10000
CMD ["npm", "start"]
