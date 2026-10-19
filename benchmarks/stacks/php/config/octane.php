<?php

use Laravel\Octane\Contracts\OperationTerminated;
use Laravel\Octane\Events\RequestHandled;
use Laravel\Octane\Events\RequestReceived;
use Laravel\Octane\Events\RequestTerminated;
use Laravel\Octane\Events\TaskReceived;
use Laravel\Octane\Events\TaskTerminated;
use Laravel\Octane\Events\TickReceived;
use Laravel\Octane\Events\TickTerminated;
use Laravel\Octane\Events\WorkerErrorOccurred;
use Laravel\Octane\Events\WorkerStarting;
use Laravel\Octane\Events\WorkerStopping;
use Laravel\Octane\Listeners\CloseMonologHandlers;
use Laravel\Octane\Listeners\EnsureUploadedFilesAreValid;
use Laravel\Octane\Listeners\EnsureUploadedFilesCanBeMoved;
use Laravel\Octane\Listeners\FlushOnce;
use Laravel\Octane\Listeners\FlushTemporaryContainerInstances;
use Laravel\Octane\Listeners\ReportException;
use Laravel\Octane\Listeners\StopWorkerIfNecessary;
use Laravel\Octane\Octane;

return [

    'server' => env('OCTANE_SERVER', 'swoole'),

    'https' => env('OCTANE_HTTPS', false),

    // Sized for the benchmark's 2 CPUs: one request worker per CPU, no task workers. Workers are recycled after
    // max_requests requests (Octane's default of 500 would re-bootstrap Laravel several times a second under load).
    'workers' => (int) env('OCTANE_WORKERS', 2),
    'task_workers' => 0,
    'max_requests' => (int) env('OCTANE_MAX_REQUESTS', 10000),

    // Octane's default listeners. The database connection is kept open across requests (no DisconnectFromDatabases).
    'listeners' => [
        WorkerStarting::class => [
            EnsureUploadedFilesAreValid::class,
            EnsureUploadedFilesCanBeMoved::class,
        ],
        RequestReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
            ...Octane::prepareApplicationForNextRequest(),
        ],
        RequestHandled::class => [],
        RequestTerminated::class => [],
        TaskReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
        ],
        TaskTerminated::class => [],
        TickReceived::class => [
            ...Octane::prepareApplicationForNextOperation(),
        ],
        TickTerminated::class => [],
        OperationTerminated::class => [
            FlushOnce::class,
            FlushTemporaryContainerInstances::class,
        ],
        WorkerErrorOccurred::class => [
            ReportException::class,
            StopWorkerIfNecessary::class,
        ],
        WorkerStopping::class => [
            CloseMonologHandlers::class,
        ],
    ],

    // Nothing is encrypted (no sessions, cookies or APP_KEY), so the encrypter is not warmed.
    'warm' => array_values(array_diff(Octane::defaultServicesToWarm(), ['encrypter'])),

    'flush' => [],

    'tables' => [],

    'cache' => [
        'rows' => 1000,
        'bytes' => 10000,
    ],

    'watch' => [],

    'garbage' => 50,

    'max_execution_time' => 30,

    // No task workers run (--task-workers=0), so there is nothing to tick.
    'tick' => false,

    // Nothing is served from public/: skip the per-request static file lookup.
    'serve_static_files' => false,

    'swoole' => [
        'options' => [
            'http_compression' => false,
            'package_max_length' => 10 * 1024 * 1024,
        ],
    ],

    'state_file' => env('OCTANE_STATE_FILE', storage_path('logs/octane-server-state.json')),

];
