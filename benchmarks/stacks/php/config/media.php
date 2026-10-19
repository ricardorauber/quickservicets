<?php

return [

    // Where POST /media stores the uploaded bytes (`<upload_dir>/media/<id>/<objectId><ext>`).
    'upload_dir' => env('UPLOAD_DIR', storage_path('app/uploads')),

];
