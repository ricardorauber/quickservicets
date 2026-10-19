<?php

namespace App\Support;

/** Timestamps as the contract writes them: UTC, millisecond precision, `2026-10-19T16:04:45.600Z`. */
final class Clock
{
    /** The current time, truncated to milliseconds. */
    public static function now(): string
    {
        [$micro, $seconds] = explode(' ', microtime());

        return gmdate('Y-m-d\TH:i:s', (int) $seconds).'.'.substr($micro, 2, 3).'Z';
    }

    /** Formats a `timestamp with time zone` read in a UTC session (`2026-10-19 16:04:45.6+00`). */
    public static function iso(string $value): string
    {
        $fraction = '000';
        if (($value[19] ?? '') === '.') {
            $digits = strspn($value, '0123456789', 20);
            $fraction = str_pad(substr($value, 20, min($digits, 3)), 3, '0');
        }

        return substr($value, 0, 10).'T'.substr($value, 11, 8).'.'.$fraction.'Z';
    }
}
