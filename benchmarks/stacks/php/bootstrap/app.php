<?php

use App\Support\Api;
use App\Support\ApiError;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Foundation\Http\Middleware\InvokeDeferredCallbacks;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        apiPrefix: '',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // A JSON API behind no proxy: no CORS, maintenance-mode check, string trimming or empty-string conversion
        // (the controllers read the raw body and query string).
        $middleware->use([InvokeDeferredCallbacks::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->dontReport(ApiError::class);
        $exceptions->render(fn (ApiError $e) => $e->toResponse());
        $exceptions->render(fn (NotFoundHttpException $e) => Api::error(404, 'Route not found'));
        $exceptions->render(fn (MethodNotAllowedHttpException $e) => Api::error(405, 'Method not allowed', null, $e->getHeaders()));
        $exceptions->render(fn (Throwable $e) => Api::error(500, 'Internal server error'));
    })->create();
