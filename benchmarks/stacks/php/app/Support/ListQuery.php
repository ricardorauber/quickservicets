<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;

/**
 * The query parameters of the list and read routes (`limit`, `offset`, `sort`, `where[field][op]`, `fields`,
 * `populate`), parsed from the raw query string so that repeated keys can be detected, and applied to a query
 * builder. Every problem is reported together under "Invalid query".
 */
final class ListQuery
{
    public const DEFAULT_LIMIT = 20;

    public const MAX_LIMIT = 100;

    public const MAX_LIST_VALUES = 100;

    private const MAX_OFFSET = 9007199254740991;

    private const OPERATORS = [
        'eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'exists', 'isNull',
        'containsAny', 'containsAll', 'size', 'isEmpty',
    ];

    private const COMMON = ['eq', 'ne', 'in', 'nin', 'exists', 'isNull'];

    private const OPERATORS_BY_TYPE = [
        'id' => self::COMMON,
        'enum' => self::COMMON,
        'string' => [...self::COMMON, 'contains', 'startsWith'],
        'number' => [...self::COMMON, 'gt', 'gte', 'lt', 'lte'],
        'date' => [...self::COMMON, 'gt', 'gte', 'lt', 'lte'],
        'refArray' => ['contains', 'containsAny', 'containsAll', 'size', 'isEmpty'],
    ];

    private const COMPARISONS = ['eq' => '=', 'ne' => '<>', 'gt' => '>', 'gte' => '>=', 'lt' => '<', 'lte' => '<='];

    private const ISO_8601 = '/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/D';

    /** @var list<array{0: string|null, 1: string, 2: mixed}> column, operator, value */
    public array $where = [];

    /** @var list<array{0: string, 1: string}> column, direction */
    public array $sort = [];

    public int $limit = self::DEFAULT_LIMIT;

    public int $offset = 0;

    /** @var list<string>|null the selected fields, or null for every field */
    public ?array $fields = null;

    /** @var list<string> */
    public array $populate = [];

    /** @var list<array{field: string, message: string}> */
    private array $errors = [];

    /**
     * Parses the parameters of a list route.
     *
     * @param  array<string, array{0: string|null, 1: string}>  $schema
     * @param  list<string>  $references  the fields that can be populated
     */
    public static function forList(?string $queryString, array $schema, array $references = []): self
    {
        $query = new self;
        $seen = [];
        $single = [];
        foreach (self::pairs($queryString) as [$key, $raw]) {
            if (isset($seen[$key])) {
                $query->error($key, 'Parameter is repeated');

                continue;
            }
            $seen[$key] = true;
            if (str_starts_with($key, 'where[') && preg_match('/^where\[([^\]]+)\]\[([^\]]+)\](?:\[([^\]]+)\])?$/D', $key, $match)) {
                $query->condition($match[1], $match[2], $raw, $key, $schema, $match[3] ?? null);
            } elseif ($key === 'sort' || $key === 'limit' || $key === 'offset' || $key === 'fields' || $key === 'populate') {
                $single[$key] = $raw;
            } else {
                $query->error($key, 'Unknown parameter');
            }
        }
        $query->parseFields($single['fields'] ?? null, $schema);
        $query->parseSort($single['sort'] ?? null, $schema);
        $query->limit = $query->integer($single['limit'] ?? null, 'limit', 1, self::MAX_LIMIT, self::DEFAULT_LIMIT);
        $query->offset = $query->integer($single['offset'] ?? null, 'offset', 0, self::MAX_OFFSET, 0);
        $query->finish($single['populate'] ?? null, $references);

        return $query;
    }

    /**
     * Parses `fields` and `populate` of a read route; other parameters are ignored, and the first of repeated
     * keys wins.
     *
     * @param  array<string, array{0: string|null, 1: string}>  $schema
     * @param  list<string>  $references
     */
    public static function forRead(?string $queryString, array $schema, array $references = []): self
    {
        $query = new self;
        if ($queryString === null || $queryString === '') {
            return $query;
        }
        $single = [];
        foreach (self::pairs($queryString) as [$key, $raw]) {
            if (($key === 'fields' || $key === 'populate') && ! isset($single[$key])) {
                $single[$key] = $raw;
            }
        }
        $query->parseFields($single['fields'] ?? null, $schema);
        $query->finish($single['populate'] ?? null, $references);

        return $query;
    }

    /** Whether the response includes the given field. */
    public function selects(string $field): bool
    {
        return $this->fields === null || in_array($field, $this->fields, true);
    }

    /**
     * The columns to read for the selected fields.
     *
     * @param  array<string, array{0: string|null, 1: string}>  $schema
     * @param  list<string>  $all
     * @param  list<string>  $required  columns needed whatever the selection
     * @return list<string>
     */
    public function columns(array $schema, array $all, array $required = []): array
    {
        if ($this->fields === null) {
            return $all;
        }
        $columns = $required;
        foreach ($this->fields as $field) {
            $column = $schema[$field][0];
            if ($column !== null && ! in_array($column, $columns, true)) {
                $columns[] = $column;
            }
        }

        return $columns === [] ? ['id'] : $columns;
    }

    /** Adds the filters to a query on `$table`. */
    public function applyWhere(Builder $query, string $table): Builder
    {
        foreach ($this->where as [$column, $operator, $value]) {
            if ($column === null) {
                $this->applyMembersCondition($query, $table, $operator, $value);

                continue;
            }
            match ($operator) {
                'eq', 'ne', 'gt', 'gte', 'lt', 'lte' => $query->where($column, self::COMPARISONS[$operator], $value),
                'in' => $query->whereIn($column, $value),
                'nin' => $query->whereNotIn($column, $value),
                'exists' => $value ? $query->whereNotNull($column) : $query->whereNull($column),
                'isNull' => $value ? $query->whereNull($column) : $query->whereNotNull($column),
                'contains' => $query->where($column, 'ilike', '%'.self::escapeLike($value).'%'),
                'startsWith' => $query->where($column, 'ilike', self::escapeLike($value).'%'),
            };
        }

        return $query;
    }

    /** Adds the sort, the tie-breaker included, and the page. */
    public function applyPage(Builder $query): Builder
    {
        foreach ($this->sort as [$column, $direction]) {
            $query->orderBy($column, $direction);
        }

        return $query->limit($this->limit)->offset($this->offset);
    }

    /** Conditions on the reference array `members`, through the junction table. */
    private function applyMembersCondition(Builder $query, string $table, string $operator, mixed $value): void
    {
        $owner = '"organizations__members"."owner_id" = "'.$table.'"."id"';
        match ($operator) {
            'contains' => $query->whereRaw("exists (select 1 from \"organizations__members\" where $owner and \"target_id\" = ?)", [$value]),
            'containsAny' => $query->whereRaw(
                "exists (select 1 from \"organizations__members\" where $owner and \"target_id\" in (".self::placeholders($value).'))',
                $value,
            ),
            'containsAll' => $query->whereRaw(
                "(select count(*) from \"organizations__members\" where $owner and \"target_id\" in (".self::placeholders($value).')) = ?',
                [...$value, count($value)],
            ),
            'size' => $query->whereRaw(
                "(select count(*) from \"organizations__members\" where $owner) ".self::COMPARISONS[$value[0]].' ?',
                [$value[1]],
            ),
            'isEmpty' => $query->whereRaw(($value ? 'not ' : '')."exists (select 1 from \"organizations__members\" where $owner)"),
        };
    }

    private static function placeholders(array $values): string
    {
        return implode(', ', array_fill(0, count($values), '?'));
    }

    private static function escapeLike(string $value): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
    }

    /**
     * The decoded key/value pairs of a query string, in order, as URLSearchParams reads them.
     *
     * @return list<array{0: string, 1: string}>
     */
    private static function pairs(?string $queryString): array
    {
        if ($queryString === null || $queryString === '') {
            return [];
        }
        $pairs = [];
        foreach (explode('&', $queryString) as $pair) {
            if ($pair === '') {
                continue;
            }
            $equals = strpos($pair, '=');
            $pairs[] = $equals === false
                ? [urldecode($pair), '']
                : [urldecode(substr($pair, 0, $equals)), urldecode(substr($pair, $equals + 1))];
        }

        return $pairs;
    }

    private function error(string $field, string $message): void
    {
        $this->errors[] = ['field' => $field, 'message' => $message];
    }

    /** Throws the collected errors, then validates `populate` (reported on its own, like the reference). */
    private function finish(?string $populate, array $references): void
    {
        if ($this->errors !== []) {
            throw ApiError::invalidQuery($this->errors);
        }
        if ($populate === null) {
            return;
        }
        $details = [];
        foreach (explode(',', $populate) as $path) {
            $path = trim($path);
            if ($path === '') {
                continue;
            }
            if (in_array($path, $references, true)) {
                if (! in_array($path, $this->populate, true)) {
                    $this->populate[] = $path;
                }
            } else {
                $details[] = ['field' => 'populate', 'message' => "Cannot populate: $path"];
            }
        }
        if ($details !== []) {
            throw new ApiError(400, $details[0]['message'], $details);
        }
    }

    private function parseFields(?string $raw, array $schema): void
    {
        if ($raw === null) {
            return;
        }
        $fields = [];
        foreach (explode(',', $raw) as $field) {
            $field = trim($field);
            if ($field !== '' && ! in_array($field, $fields, true)) {
                $fields[] = $field;
            }
        }
        if ($fields === []) {
            $this->error('fields', 'Must list at least one field');

            return;
        }
        $valid = true;
        foreach ($fields as $field) {
            if (! isset($schema[$field])) {
                $this->error('fields', "Unknown field: $field");
                $valid = false;
            }
        }
        if ($valid) {
            $this->fields = $fields;
        }
    }

    private function parseSort(?string $raw, array $schema): void
    {
        $seen = [];
        if ($raw === null) {
            $this->sort[] = ['created_at', 'desc'];
            $seen['createdAt'] = true;
        } else {
            foreach (explode(',', $raw) as $part) {
                $part = trim($part);
                $descending = str_starts_with($part, '-');
                $name = $descending ? substr($part, 1) : $part;
                $column = $schema[$name][0] ?? null;
                if ($column === null) {
                    $this->error('sort', "Field \"$name\" cannot be sorted");

                    continue;
                }
                if (isset($seen[$name])) {
                    $this->error('sort', "Field \"$name\" is listed more than once");

                    continue;
                }
                $seen[$name] = true;
                $this->sort[] = [$column, $descending ? 'desc' : 'asc'];
            }
        }
        if (! isset($seen['id'])) {
            $this->sort[] = ['id', 'desc'];
        }
    }

    private function integer(?string $raw, string $name, int $min, int $max, int $default): int
    {
        if ($raw === null) {
            return $default;
        }
        if (preg_match('/^-?\d+$/D', $raw) === 1) {
            $value = (float) $raw;
            if ($value >= $min && $value <= $max) {
                return (int) $raw;
            }
        }
        $this->error($name, $max === self::MAX_OFFSET ? "Must be an integer of at least $min" : "Must be an integer from $min to $max");

        return $default;
    }

    private function condition(string $name, string $operator, string $raw, string $param, array $schema, ?string $comparison): void
    {
        if (! isset($schema[$name])) {
            $this->error($param, "Field \"$name\" cannot be filtered");

            return;
        }
        [$column, $type] = $schema[$name];
        if (! in_array($operator, self::OPERATORS, true)) {
            $this->error($param, "Unknown operator \"$operator\"");

            return;
        }
        if (! in_array($operator, self::OPERATORS_BY_TYPE[$type], true)) {
            $this->error($param, "Operator \"$operator\" is not allowed for this field");

            return;
        }
        if (($operator === 'size') !== ($comparison !== null)) {
            $this->error($param, $operator === 'size' ? 'Use where[field][size][eq|ne|gt|gte|lt|lte]' : "Unknown operator \"$operator\"");

            return;
        }
        if ($operator === 'size') {
            if (! isset(self::COMPARISONS[$comparison])) {
                $this->error($param, "Unknown operator \"$comparison\"");
            } elseif (preg_match('/^\d+$/D', $raw) !== 1) {
                $this->error($param, 'Must be a non-negative integer');
            } else {
                $this->where[] = [$column, 'size', [$comparison, (int) $raw]];
            }

            return;
        }
        if ($operator === 'isEmpty' || $operator === 'exists' || $operator === 'isNull') {
            if ($raw !== 'true' && $raw !== 'false') {
                $this->error($param, 'Must be true or false');
            } else {
                $this->where[] = [$column, $operator, $raw === 'true'];
            }

            return;
        }
        if ($operator === 'in' || $operator === 'nin' || $operator === 'containsAny' || $operator === 'containsAll') {
            $items = [];
            foreach (explode(',', $raw) as $item) {
                $item = trim($item);
                if ($item !== '') {
                    $items[] = $item;
                }
            }
            if ($items === []) {
                $this->error($param, 'Must list at least one value');

                return;
            }
            if (count($items) > self::MAX_LIST_VALUES) {
                $this->error($param, 'Must list at most '.self::MAX_LIST_VALUES.' values');

                return;
            }
            if ($type === 'refArray') {
                $this->where[] = [$column, $operator, array_values(array_unique($items))];

                return;
            }
            $before = count($this->errors);
            $values = [];
            foreach ($items as $item) {
                $values[] = $this->coerce($item, $type, $param);
            }
            if (count($this->errors) === $before) {
                $this->where[] = [$column, $operator, $values];
            }

            return;
        }
        if ($type === 'refArray') {
            if (trim($raw) === '') {
                $this->error($param, 'Must not be empty');
            } else {
                $this->where[] = [$column, $operator, $raw];
            }

            return;
        }
        $before = count($this->errors);
        $value = $this->coerce($raw, $type, $param);
        if (count($this->errors) === $before) {
            $this->where[] = [$column, $operator, $value];
        }
    }

    private function coerce(string $raw, string $type, string $param): mixed
    {
        switch ($type) {
            case 'number':
                if (trim($raw) === '' || ! is_numeric(trim($raw)) || ! is_finite((float) trim($raw))) {
                    $this->error($param, 'Must be a number');

                    return null;
                }

                return (float) trim($raw);
            case 'date':
                if (preg_match(self::ISO_8601, $raw) !== 1 || strtotime($raw) === false) {
                    $this->error($param, 'Must be an ISO 8601 date');

                    return null;
                }

                return $raw;
            case 'enum':
                if (! in_array($raw, Schema::ROLES, true)) {
                    $this->error($param, 'Must be one of: '.implode(', ', Schema::ROLES));

                    return null;
                }

                return $raw;
            default:
                return $raw;
        }
    }
}
