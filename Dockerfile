FROM node:22-slim
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev
ENV AIKEA_HOME=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js", "--http"]
