FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY health-server.js ./
COPY shared ./shared
# 容器内必须监听 0.0.0.0，否则端口映射打进不来；对外暴露由 compose 的 ports 控制
ENV HEALTH_MCP_HOST=0.0.0.0
EXPOSE 47831
CMD ["node", "health-server.js"]
