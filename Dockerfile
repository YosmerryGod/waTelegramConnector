FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache libstdc++ \
  && apk add --no-cache --virtual .build-deps python3 make g++ \
  && true

COPY package*.json ./

RUN npm ci --only=production \
  && apk del .build-deps

COPY . .

RUN mkdir -p /app/auth /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
