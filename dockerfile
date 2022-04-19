## dockerfile node 16
FROM node:16

COPY package.json /package.json
COPY yarn.lock /yarn.lock
RUN yarn --frozen-lockfile
COPY . /
RUN yarn build


CMD [ "node", "/dist/index.js" ]

