<?php

use Illuminate\Support\Str;

return [

    'default' => env('DB_CONNECTION', 'pgsql'),

    'connections' => [

        // One connection per Octane worker, opened on the first query and kept for the worker's lifetime.
        'pgsql' => [
            'driver' => 'pgsql',
            'url' => env('DATABASE_URL'),
            'host' => env('DB_HOST', '127.0.0.1'),
            'port' => env('DB_PORT', '5432'),
            'database' => env('DB_NAME', 'bench'),
            'username' => env('DB_USER', 'bench'),
            'password' => env('DB_PASSWORD', 'bench'),
            'charset' => 'utf8',
            'prefix' => '',
            'prefix_indexes' => true,
            'search_path' => 'public',
            'sslmode' => env('DB_SSLMODE', 'disable'),
            'timezone' => 'UTC',
            'options' => [
                // Send each query with its parameters in one round trip (PQexecParams) instead of a named
                // server-side prepare + execute + deallocate per statement.
                Pdo\Pgsql::ATTR_DISABLE_PREPARES => true,
            ],
        ],

    ],

    'migrations' => [
        'table' => 'migrations',
        'update_date_on_publish' => true,
    ],

    'redis' => [
        'client' => env('REDIS_CLIENT', 'phpredis'),
        'options' => [
            'prefix' => env('REDIS_PREFIX', Str::slug((string) env('APP_NAME', 'laravel')).'-database-'),
        ],
    ],

];
