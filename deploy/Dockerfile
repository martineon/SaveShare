FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY shared ./shared
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 SAVESHARE_DATA=/data
EXPOSE 8787
CMD ["node", "server/index.cjs"]
