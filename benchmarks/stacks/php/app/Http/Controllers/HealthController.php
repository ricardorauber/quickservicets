<?php

namespace App\Http\Controllers;

use App\Support\Api;
use Illuminate\Http\JsonResponse;

final class HealthController
{
    public function __invoke(): JsonResponse
    {
        return Api::json(['ok' => true]);
    }
}
