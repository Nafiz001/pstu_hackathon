# Build the SPA, then serve the static output. The runtime image contains nginx and a few hundred
# kilobytes of assets — no Node, no node_modules, nothing that can execute.
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
