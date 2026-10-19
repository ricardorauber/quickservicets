<?php

namespace App\Support;

/**
 * The fields the list and read routes expose, with their column and query type. `refArray` fields live in the
 * junction table `organizations__members`, so they have no column.
 */
final class Schema
{
    public const ROLES = ['member', 'admin'];

    /** @var array<string, array{0: string, 1: string}> */
    public const USERS = [
        'id' => ['id', 'id'],
        'createdAt' => ['created_at', 'date'],
        'updatedAt' => ['updated_at', 'date'],
        'email' => ['email', 'string'],
        'name' => ['name', 'string'],
        'role' => ['role', 'enum'],
        'age' => ['age', 'number'],
    ];

    /** @var array<string, array{0: string|null, 1: string}> */
    public const ORGANIZATIONS = [
        'id' => ['id', 'id'],
        'createdAt' => ['created_at', 'date'],
        'updatedAt' => ['updated_at', 'date'],
        'name' => ['name', 'string'],
        'slug' => ['slug', 'string'],
        'members' => [null, 'refArray'],
    ];

    public const USER_COLUMNS = ['id', 'created_at', 'updated_at', 'email', 'name', 'role', 'age'];

    public const ORGANIZATION_COLUMNS = ['id', 'created_at', 'updated_at', 'name', 'slug'];

    public const MEDIA_COLUMNS = ['id', 'created_at', 'updated_at', 'filename', 'mime_type', 'size', 'storage'];
}
