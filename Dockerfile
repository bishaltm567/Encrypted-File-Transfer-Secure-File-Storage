FROM node:20-alpine
WORKDIR /app
COPY . .
RUN mkdir -p storage && chown -R node:node /app
USER node
ENV PORT=10000 STORAGE_DIR=/app/storage
EXPOSE 10000
CMD ["npm","start"]
