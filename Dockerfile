FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY health-server.js ./
COPY training-load.js ./
COPY shared ./shared
# 参数文件也进镜像，不用挂载也能跑；compose 里仍然挂载，便于改完立刻生效
COPY body-battery.json heart-rate.json training-load.json wake-notify.json ./
# 容器内必须监听 0.0.0.0，否则端口映射打进不来；对外暴露由 compose 的 ports 控制
ENV HEALTH_MCP_HOST=0.0.0.0
EXPOSE 47831
CMD ["node", "health-server.js"]
