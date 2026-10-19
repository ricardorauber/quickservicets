<?php

return [

    'default' => env('FILESYSTEM_DISK', 'local'),

    // Uploads are written to UPLOAD_DIR directly (config/media.php); the local disk is not served over HTTP.
    'disks' => [
        'local' => [
            'driver' => 'local',
            'root' => storage_path('app/private'),
            'serve' => false,
            'throw' => false,
            'report' => false,
        ],
    ],

];
