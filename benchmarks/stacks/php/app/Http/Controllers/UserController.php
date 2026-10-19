<?php

namespace App\Http\Controllers;

use App\Support\Api;
use App\Support\Clock;
use App\Support\ListQuery;
use App\Support\Records;
use App\Support\Schema;
use App\Support\UserInput;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final class UserController
{
    private const RETURNING = 'returning "id", "created_at", "updated_at", "email", "name", "role", "age"';

    public function index(Request $request): JsonResponse
    {
        $query = ListQuery::forList($request->server('QUERY_STRING'), Schema::USERS);
        $filtered = $query->applyWhere(DB::table('users'), 'users');
        $total = (clone $filtered)->count();
        $rows = $query->applyPage($filtered->select($query->columns(Schema::USERS, Schema::USER_COLUMNS)))->get();

        $data = [];
        foreach ($rows as $row) {
            $data[] = Records::user($row, $query->fields);
        }

        return Api::json(['data' => $data, 'total' => $total, 'limit' => $query->limit, 'offset' => $query->offset]);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $query = ListQuery::forRead($request->server('QUERY_STRING'), Schema::USERS);
        $row = DB::table('users')->where('id', $id)->first($query->columns(Schema::USERS, Schema::USER_COLUMNS));

        return $row === null ? Api::notFound('User not found') : Api::json(Records::user($row, $query->fields));
    }

    public function store(Request $request): JsonResponse
    {
        $values = UserInput::validate($request, create: true);
        $now = Clock::now();
        $user = [
            'id' => Str::uuid7()->toString(),
            'createdAt' => $now,
            'updatedAt' => $now,
            'email' => $values['email'],
            'name' => $values['name'],
            'role' => $values['role'] ?? 'member',
            'age' => $values['age'] ?? null,
        ];
        try {
            DB::table('users')->insert([
                'id' => $user['id'],
                'created_at' => $now,
                'updated_at' => $now,
                'email' => $user['email'],
                'name' => $user['name'],
                'role' => $user['role'],
                'age' => $user['age'],
            ]);
        } catch (UniqueConstraintViolationException) {
            return self::emailTaken();
        }

        return Api::json($user, 201);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $values = UserInput::validate($request, create: false);
        $sets = [];
        $bindings = [];
        foreach ($values as $column => $value) {
            $sets[] = "\"$column\" = ?";
            $bindings[] = $value;
        }
        $sets[] = '"updated_at" = ?';
        $bindings[] = Clock::now();
        $bindings[] = $id;

        try {
            $row = DB::selectOne('update "users" set '.implode(', ', $sets).' where "id" = ? '.self::RETURNING, $bindings);
        } catch (UniqueConstraintViolationException) {
            return self::emailTaken();
        }

        return $row === null ? Api::notFound('User not found') : Api::json(Records::user($row));
    }

    public function destroy(string $id): Response|JsonResponse
    {
        // The junction rows cascade; the organizations that listed the user get a new updatedAt in the same
        // transaction (before the delete, while the junction rows still exist).
        $deleted = DB::transaction(function () use ($id) {
            DB::table('organizations')
                ->whereIn('id', fn ($query) => $query->select('owner_id')->from('organizations__members')->where('target_id', $id))
                ->update(['updated_at' => Clock::now()]);

            return DB::table('users')->where('id', $id)->delete();
        });

        return $deleted === 0 ? Api::notFound('User not found') : response()->noContent();
    }

    private static function emailTaken(): JsonResponse
    {
        return Api::error(409, 'Value already exists', [['field' => 'email', 'message' => 'Value already exists']]);
    }
}
