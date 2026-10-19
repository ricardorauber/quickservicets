<?php

namespace App\Support;

use Illuminate\Http\Request;

/** Reads and validates the JSON body of `POST /users` and `PATCH /users/{id}`. */
final class UserInput
{
    private const EMAIL = '/(*UCP)^[^\s@]+@[^\s@]+\.[^\s@]+$/uD';

    private const READ_ONLY = ['id' => true, 'createdAt' => true, 'updatedAt' => true];

    private const FIELDS = ['email' => true, 'name' => true, 'role' => true, 'age' => true];

    /**
     * The valid values of the body, keyed by column. Throws a 400 listing every problem.
     *
     * @return array<string, mixed>
     */
    public static function validate(Request $request, bool $create): array
    {
        $body = self::object($request);
        $values = [];
        $details = [];

        foreach (self::FIELDS as $field => $_) {
            if (! property_exists($body, $field)) {
                if ($create && ($field === 'email' || $field === 'name')) {
                    $details[] = ['field' => $field, 'message' => 'Is required'];
                }

                continue;
            }
            $value = $body->{$field};
            $message = match ($field) {
                'email' => self::email($value),
                'name' => self::name($value),
                'role' => self::role($value),
                'age' => self::age($value),
            };
            if ($message !== null) {
                $details[] = ['field' => $field, 'message' => $message];
            } else {
                $values[$field] = $field === 'age' && $value !== null ? (int) $value : $value;
            }
        }

        foreach (get_object_vars($body) as $key => $_) {
            $key = (string) $key;
            if (isset(self::FIELDS[$key])) {
                continue;
            }
            $details[] = ['field' => $key, 'message' => isset(self::READ_ONLY[$key]) ? 'Field is read-only' : 'Unknown field'];
        }

        if ($details !== []) {
            throw ApiError::invalidBody($details);
        }

        return $values;
    }

    private static function object(Request $request): object
    {
        $content = $request->getContent();
        try {
            $body = json_decode($content, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiError(400, 'Invalid JSON body');
        }
        if (! $body instanceof \stdClass) {
            throw ApiError::invalidBody([['field' => '', 'message' => 'Body must be a JSON object']]);
        }

        return $body;
    }

    private static function email(mixed $value): ?string
    {
        return match (true) {
            $value === null => 'Cannot be null',
            ! is_string($value) => 'Must be a string',
            preg_match(self::EMAIL, $value) !== 1 => 'Must be a valid email',
            default => null,
        };
    }

    private static function name(mixed $value): ?string
    {
        if ($value === null) {
            return 'Cannot be null';
        }
        if (! is_string($value)) {
            return 'Must be a string';
        }
        $length = self::utf16Length($value);

        return match (true) {
            $length < 1 => 'Must be at least 1 characters',
            $length > 100 => 'Must be at most 100 characters',
            default => null,
        };
    }

    private static function role(mixed $value): ?string
    {
        return match (true) {
            $value === null => 'Cannot be null',
            ! in_array($value, Schema::ROLES, true) => 'Must be one of: '.implode(', ', Schema::ROLES),
            default => null,
        };
    }

    private static function age(mixed $value): ?string
    {
        return match (true) {
            $value === null => null,
            ! is_int($value) && ! is_float($value) => 'Must be a number',
            is_float($value) && (! is_finite($value) || floor($value) != $value) => 'Must be an integer',
            $value < 0 => 'Must be at least 0',
            $value > 150 => 'Must be at most 150',
            default => null,
        };
    }

    /** The length in UTF-16 code units, as JavaScript's `length`. */
    private static function utf16Length(string $value): int
    {
        $bytes = strlen($value);
        if ($bytes === 0 || ! preg_match('/[\x80-\xFF]/', $value)) {
            return $bytes;
        }

        // Characters outside the BMP (4-byte sequences) count twice.
        return mb_strlen($value, 'UTF-8') + preg_match_all('/[\xF0-\xF7]/', $value);
    }
}
