# Node + Chroma in one container for Render
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages chromadb

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data/handbook/uploads

# Chroma in background, then Node (foreground). Render sets PORT.
ENV CHROMA_HOST=127.0.0.1
ENV CHROMA_PORT=8000
EXPOSE 3000

CMD chroma run --path /app/data/chroma --port 8000 --host 127.0.0.1 & \
    sleep 3 && \
    node server/app.js
