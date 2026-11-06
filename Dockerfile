# syntax=docker/dockerfile:1.7
FROM nginxinc/nginx-unprivileged:1.29-alpine
LABEL org.opencontainers.image.source="https://github.com/DemonIngvi/proview-web" \
      org.opencontainers.image.description="ProView demo site and browser SDK" \
      org.opencontainers.image.licenses="Apache-2.0"

# Endpoints for the SDK; empty = same origin (requests go through the proxy below).
ENV BANNER_ENDPOINT="" \
    COLLECTOR_ENDPOINT="" \
    BANNER_UPSTREAM="proview-banner-service:8080" \
    COLLECTOR_UPSTREAM="proview-event-collector:8080" \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY public/ /usr/share/nginx/html/
COPY sdk/tracker.js sdk/queue.js sdk/proview.js /usr/share/nginx/html/sdk/
EXPOSE 8080 9090
