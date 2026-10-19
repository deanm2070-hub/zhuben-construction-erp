# LibreDWG (GPLv3) is built from the GNU release and runs as a separate process.
FROM debian:bookworm-slim AS build
ARG LIBREDWG_VERSION=0.13.3
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils python3 \
 && curl -fsSL https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz | tar -xJ -C /tmp \
 && cd /tmp/libredwg-${LIBREDWG_VERSION} \
 && ./configure --disable-bindings --disable-docs --prefix=/opt/libredwg \
 && make -j"$(nproc)" && make install

FROM node:20-bookworm-slim
COPY --from=build /opt/libredwg /opt/libredwg
ENV PATH="/opt/libredwg/bin:${PATH}" LD_LIBRARY_PATH="/opt/libredwg/lib"
WORKDIR /app
COPY package.json server.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
