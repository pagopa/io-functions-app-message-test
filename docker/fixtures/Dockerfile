FROM node:18.13.0-alpine@sha256:fda98168118e5a8f4269efca4101ee51dd5c75c0fe56d8eb6fad80455c2f5827

WORKDIR /opt/cosmosdb

RUN apk add git
RUN npm install -g ts-node typescript && \
    npm install documentdb @types/documentdb io-functions-commons \
    io-ts@1.8.5 fp-ts@1.12.0 @pagopa/ts-commons

COPY docker/fixtures/index.ts /opt/cosmosdb

CMD ["sh", "-c", "ts-node index"]
