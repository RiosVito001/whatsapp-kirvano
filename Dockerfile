FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data/auth
ENV AUTH_DIR=/data/auth
CMD ["npm","start"]
