<?php

namespace App\Support;

use Illuminate\Http\JsonResponse;

/** JSON responses and the contract's error envelope. */
final class Api
{
    public const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

    private const CODES = [
        400 => 'VALIDATION_ERROR',
        404 => 'NOT_FOUND',
        405 => 'METHOD_NOT_ALLOWED',
        409 => 'CONFLICT',
        413 => 'PAYLOAD_TOO_LARGE',
        415 => 'UNSUPPORTED_MEDIA_TYPE',
        500 => 'INTERNAL_ERROR',
    ];

    public static function json(mixed $data, int $status = 200): JsonResponse
    {
        return new JsonResponse($data, $status, [], self::JSON_FLAGS);
    }

    /**
     * @param  list<array{field: string, message: string}>|null  $details
     * @param  array<string, string>  $headers
     */
    public static function error(int $status, string $message, ?array $details = null, array $headers = []): JsonResponse
    {
        $error = ['code' => self::CODES[$status] ?? 'ERROR', 'message' => $message];
        if ($details !== null) {
            $error['details'] = $details;
        }

        return new JsonResponse(['error' => $error], $status, $headers, self::JSON_FLAGS);
    }

    public static function notFound(string $message): JsonResponse
    {
        return self::error(404, $message);
    }
}
