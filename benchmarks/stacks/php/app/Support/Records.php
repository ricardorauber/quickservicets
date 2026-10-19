<?php

namespace App\Support;

/** Turns database rows into the JSON records of the contract. */
final class Records
{
    /** @param  list<string>|null  $fields */
    public static function user(object $row, ?array $fields = null): array
    {
        if ($fields === null) {
            return [
                'id' => $row->id,
                'createdAt' => Clock::iso($row->created_at),
                'updatedAt' => Clock::iso($row->updated_at),
                'email' => $row->email,
                'name' => $row->name,
                'role' => $row->role,
                'age' => self::number($row->age),
            ];
        }
        $record = [];
        foreach ($fields as $field) {
            $record[$field] = match ($field) {
                'createdAt' => Clock::iso($row->created_at),
                'updatedAt' => Clock::iso($row->updated_at),
                'age' => self::number($row->age),
                default => $row->{$field},
            };
        }

        return $record;
    }

    /**
     * @param  list<string>|null  $fields
     * @param  list<mixed>  $members  member ids, or populated user records
     */
    public static function organization(object $row, array $members, ?array $fields = null): array
    {
        if ($fields === null) {
            return [
                'id' => $row->id,
                'createdAt' => Clock::iso($row->created_at),
                'updatedAt' => Clock::iso($row->updated_at),
                'name' => $row->name,
                'slug' => $row->slug,
                'members' => $members,
            ];
        }
        $record = [];
        foreach ($fields as $field) {
            $record[$field] = match ($field) {
                'createdAt' => Clock::iso($row->created_at),
                'updatedAt' => Clock::iso($row->updated_at),
                'members' => $members,
                default => $row->{$field},
            };
        }

        return $record;
    }

    public static function media(object $row): array
    {
        return [
            'id' => $row->id,
            'createdAt' => Clock::iso($row->created_at),
            'updatedAt' => Clock::iso($row->updated_at),
            'filename' => $row->filename,
            'mimeType' => $row->mime_type,
            'size' => self::number($row->size),
            'storage' => $row->storage,
            'url' => '/media/'.$row->id.'/file',
        ];
    }

    /** A `double precision` value as JSON: integral values become integers. */
    public static function number(mixed $value): int|float|null
    {
        if ($value === null) {
            return null;
        }
        $float = (float) $value;
        $int = (int) $float;

        return $int == $float ? $int : $float;
    }
}
