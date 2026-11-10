FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY . .
# Database and ticket photos live here: mount a persistent disk/volume at /app/data.
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
