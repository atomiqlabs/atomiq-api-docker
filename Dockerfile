FROM node:24.9.0-alpine3.21 as builder
RUN apk --no-cache add curl git openssh python3
RUN npm install -g typescript
RUN curl -sf https://gobinaries.com/tj/node-prune | sh
WORKDIR /src
ADD src ./src
ADD package.json .
ADD tsconfig.json .
ADD tsconfig.api.json .
RUN git config --global url."https://".insteadOf ssh://
RUN npm install
RUN npm run build:api
RUN npm prune --omit=dev
RUN mv node_modules/yaml _yaml
RUN node-prune
RUN mv _yaml node_modules/yaml

FROM node:24.9.0-alpine3.21
WORKDIR /src
COPY --from=builder /src /src
CMD ["npm", "run", "start"]
