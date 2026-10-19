<?php

namespace App\Http\Controllers;

use App\Support\Api;
use App\Support\ListQuery;
use App\Support\Records;
use App\Support\Schema;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

final class OrganizationController
{
    private const REFERENCES = ['members'];

    public function index(Request $request): JsonResponse
    {
        $query = ListQuery::forList($request->server('QUERY_STRING'), Schema::ORGANIZATIONS, self::REFERENCES);
        $filtered = $query->applyWhere(DB::table('organizations'), 'organizations');
        $total = (clone $filtered)->count();
        $rows = $query->applyPage($filtered->select($this->columns($query)))->get();

        $data = [];
        if ($query->selects('members')) {
            $members = $this->members($query, $rows->pluck('id')->all());
            foreach ($rows as $row) {
                $data[] = Records::organization($row, $members[$row->id] ?? [], $query->fields);
            }
        } else {
            foreach ($rows as $row) {
                $data[] = Records::organization($row, [], $query->fields);
            }
        }

        return Api::json(['data' => $data, 'total' => $total, 'limit' => $query->limit, 'offset' => $query->offset]);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $query = ListQuery::forRead($request->server('QUERY_STRING'), Schema::ORGANIZATIONS, self::REFERENCES);
        $row = DB::table('organizations')->where('id', $id)->first($this->columns($query));
        if ($row === null) {
            return Api::notFound('Organization not found');
        }
        $members = $query->selects('members') ? ($this->members($query, [$id])[$id] ?? []) : [];

        return Api::json(Records::organization($row, $members, $query->fields));
    }

    public function stats(string $id): JsonResponse
    {
        $row = DB::table('organizations as o')
            ->leftJoin('organizations__members as m', 'm.owner_id', '=', 'o.id')
            ->leftJoin('users as u', 'u.id', '=', 'm.target_id')
            ->where('o.id', $id)
            ->groupBy('o.id')
            ->selectRaw("count(u.id) as members, count(*) filter (where u.role = 'admin') as admins, avg(u.age) as average_age")
            ->first();
        if ($row === null) {
            return Api::notFound('Organization not found');
        }

        return Api::json([
            'members' => (int) $row->members,
            'admins' => (int) $row->admins,
            'averageAge' => $row->average_age === null ? null : (float) $row->average_age,
        ]);
    }

    /** @return list<string> */
    private function columns(ListQuery $query): array
    {
        return $query->columns(Schema::ORGANIZATIONS, Schema::ORGANIZATION_COLUMNS, $query->selects('members') ? ['id'] : []);
    }

    /**
     * The members of the given organizations in position order, as ids or (with `populate=members`) user
     * records, loaded with one query for the whole page.
     *
     * @param  list<string>  $ids
     * @return array<string, list<mixed>>
     */
    private function members(ListQuery $query, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $members = [];
        if (in_array('members', $query->populate, true)) {
            $rows = DB::table('organizations__members as m')
                ->join('users as u', 'u.id', '=', 'm.target_id')
                ->whereIn('m.owner_id', $ids)
                ->orderBy('m.owner_id')
                ->orderBy('m.position')
                ->get(['m.owner_id', 'u.id', 'u.created_at', 'u.updated_at', 'u.email', 'u.name', 'u.role', 'u.age']);
            foreach ($rows as $row) {
                $members[$row->owner_id][] = Records::user($row);
            }
        } else {
            $rows = DB::table('organizations__members')
                ->whereIn('owner_id', $ids)
                ->orderBy('owner_id')
                ->orderBy('position')
                ->get(['owner_id', 'target_id']);
            foreach ($rows as $row) {
                $members[$row->owner_id][] = $row->target_id;
            }
        }

        return $members;
    }
}
