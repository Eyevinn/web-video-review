# Combined Dockerfile for Video Review Application
FROM node:18-alpine

# Install system dependencies including FFmpeg and nginx
RUN apk add --no-cache \
    ffmpeg \
    bash \
    curl \
    ca-certificates \
    nginx \
    supervisor \
    gettext \
    ttf-dejavu \
    fontconfig

# Create app directory
WORKDIR /app

# Copy all package files
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install server dependencies
WORKDIR /app/server
RUN npm ci --only=production

# Install client dependencies and build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --only=production
COPY client/ ./
RUN npm run build

# Copy server source code
WORKDIR /app
COPY server/ ./server/

# Create dynamic nginx configuration
RUN mkdir -p /etc/nginx/templates
COPY client/nginx.conf /etc/nginx/templates/nginx.conf.template

# Create nginx html directory and copy built React app
RUN mkdir -p /usr/share/nginx/html
RUN cp -r /app/client/build/* /usr/share/nginx/html/

# Create directory for temporary files
RUN mkdir -p /tmp/videoreview && \
    chown node:node /tmp/videoreview

# Create fontconfig cache directory and set permissions
RUN mkdir -p /data/fontconfig-cache && \
    chown node:node /data/fontconfig-cache

# Set fontconfig cache directory
ENV FONTCONFIG_CACHE=/data/fontconfig-cache

# Create entrypoint script
COPY <<EOF /entrypoint.sh
#!/bin/bash
set -e

# Set default values - nginx uses PORT, backend uses PORT+1
export PORT=\${PORT:-3001}
export BACKEND_PORT=\$((PORT + 1000))
export NGINX_PORT=\$PORT

# Debug output
echo "PORT=\$PORT"
echo "NGINX_PORT=\$NGINX_PORT"
echo "BACKEND_PORT=\$BACKEND_PORT"

# Generate nginx config from template using sed
echo "Processing nginx template..."
sed "s/\\\${NGINX_PORT:-80}/\$NGINX_PORT/g; s/\\\${PORT:-3001}/\$BACKEND_PORT/g" /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf

# Debug output
echo "Generated nginx config:"
head -30 /etc/nginx/nginx.conf

# Create supervisor configuration
mkdir -p /etc/supervisor/conf.d
cat > /etc/supervisor/conf.d/supervisord.conf << EOL
[supervisord]
nodaemon=true
user=root

[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:backend]
command=node index.js
directory=/app/server
user=node
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV=production,PORT=\$BACKEND_PORT
EOL

# Start supervisor
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
EOF

RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE ${PORT:-3001} 80

VOLUME [ "/data" ]
ENV LOCAL_CACHE_DIR=/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3001}/ || exit 1

# Start with entrypoint script
CMD ["/entrypoint.sh"]