# syntax=docker/dockerfile:1

# Dependencies: production packages only, with an authoritative class map.
FROM composer:2.10.2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts --no-autoloader --prefer-dist --ignore-platform-req=ext-*
COPY app app
COPY bootstrap bootstrap
COPY config config
COPY public public
COPY routes routes
COPY storage storage
COPY artisan artisan
RUN composer dump-autoload --no-dev --classmap-authoritative --no-scripts

# Runtime: PHP 8.4 CLI with Swoole, pdo_pgsql, pcntl (signal handling) and OPcache with the tracing JIT.
FROM php:8.4.26-cli-alpine3.23
COPY --from=mlocati/php-extension-installer:2.12.0 /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions swoole-6.2.3 pdo_pgsql pcntl opcache \
    && rm /usr/local/bin/install-php-extensions \
    && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/php.ini $PHP_INI_DIR/conf.d/zz-app.ini

WORKDIR /app
COPY --from=vendor /app /app

ENV APP_ENV=production \
    APP_DEBUG=false \
    LOG_CHANNEL=stderr \
    CACHE_STORE=array \
    SESSION_DRIVER=array \
    OCTANE_SERVER=swoole \
    OCTANE_WORKERS=2 \
    OCTANE_MAX_REQUESTS=10000 \
    PORT=8080

# Discover packages and compile the routes (Symfony's compiled URL matcher) at build time. The configuration is
# read from the environment when each worker boots, so it is not cached into the image.
RUN php artisan package:discover \
    && php artisan route:cache \
    && php artisan event:cache \
    && chown -R www-data:www-data storage bootstrap/cache \
    && mkdir -p /data/uploads && chown www-data:www-data /data/uploads
# (A fresh named volume mounted on /data/uploads takes the owner of this directory, so www-data can write to it.)

USER www-data
EXPOSE 8080
STOPSIGNAL SIGTERM
# Workers, task workers and max requests come from config/octane.php (OCTANE_WORKERS, OCTANE_MAX_REQUESTS).
CMD ["sh", "-c", "exec php artisan octane:start --server=swoole --host=0.0.0.0 --port=\"$PORT\""]
