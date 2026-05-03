FROM node:20-alpine
WORKDIR /app
COPY artifacts/api-server/dist ./artifacts/api-server/dist
RUN mkdir -p artifacts/api-server/data
EXPOSE 3000
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
