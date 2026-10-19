<?php

namespace App\Support;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/** An error that ends the request with the contract's error body. */
final class ApiError extends RuntimeException
{
    /** @param  list<array{field: string, message: string}>|null  $details */
    public function __construct(public readonly int $status, string $message, public readonly ?array $details = null)
    {
        parent::__construct($message);
    }

    public static function invalidQuery(array $details): self
    {
        return new self(400, 'Invalid query', $details);
    }

    public static function invalidBody(array $details): self
    {
        return new self(400, 'Invalid body', $details);
    }

    public function toResponse(): JsonResponse
    {
        return Api::error($this->status, $this->getMessage(), $this->details);
    }
}
