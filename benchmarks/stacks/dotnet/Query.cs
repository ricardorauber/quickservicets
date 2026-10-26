using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Npgsql;

namespace QsBench;

public enum FieldType { Id, String, Number, Date, Enum, RefArray }

/** A field of a collection as the list routes see it. `Bit` is its position in a field-selection mask. */
public sealed record FieldDef(string Name, string Column, FieldType Type, int Bit, bool Sortable = true, string[]? Values = null);

public sealed class EntityDef
{
    public required string Table { get; init; }
    public required FieldDef[] Fields { get; init; }
    public string[] PopulatablePaths { get; init; } = [];

    private Dictionary<string, FieldDef>? _byName;
    public FieldDef? Find(string name) => (_byName ??= Fields.ToDictionary(f => f.Name, StringComparer.Ordinal)).GetValueOrDefault(name);
    public int AllFields => (1 << Fields.Length) - 1;
}

public sealed record Condition(FieldDef Field, string Op, object Value);

public sealed record SortItem(FieldDef Field, bool Descending);

public sealed record ListQuery(List<Condition> Where, List<SortItem> Sort, int Limit, long Offset);

/** Parses query strings the way URLSearchParams does: ordered, case-sensitive, `+` is a space. */
public static partial class Query
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;
    public const int MaxListValues = 100;

    private static readonly string[] FilterOperators =
        ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull", "containsAny", "containsAll", "size", "isEmpty"];

    /** The operators this service implements, per field type (a subset of QuickService.ts's; the rest are "not allowed"). */
    private static string[] OperatorsFor(FieldType type) => type switch
    {
        FieldType.Number or FieldType.Date => ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte"],
        FieldType.RefArray => [],
        _ => ["eq", "ne", "in", "nin"],
    };

    public static List<KeyValuePair<string, string>> Parse(HttpRequest request)
    {
        var result = new List<KeyValuePair<string, string>>();
        var raw = request.QueryString.Value;
        if (string.IsNullOrEmpty(raw)) return result;
        var span = raw.AsSpan(raw[0] == '?' ? 1 : 0);
        foreach (var range in span.Split('&'))
        {
            var part = span[range];
            if (part.IsEmpty) continue;
            var eq = part.IndexOf('=');
            var key = eq < 0 ? part : part[..eq];
            var value = eq < 0 ? ReadOnlySpan<char>.Empty : part[(eq + 1)..];
            result.Add(new(Decode(key), Decode(value)));
        }
        return result;
    }

    private static string Decode(ReadOnlySpan<char> value)
    {
        if (value.IndexOfAny('%', '+') < 0) return value.ToString();
        var text = value.ToString().Replace('+', ' ');
        try
        {
            return Uri.UnescapeDataString(text);
        }
        catch (UriFormatException)
        {
            return text;
        }
    }

    public static string? First(List<KeyValuePair<string, string>> query, string key)
    {
        foreach (var (k, v) in query)
            if (k == key) return v;
        return null;
    }

    /** `populate`: the paths, or a 400 when one cannot be populated. */
    public static bool ParsePopulate(EntityDef entity, List<KeyValuePair<string, string>> query)
    {
        var raw = First(query, "populate");
        if (raw is null) return false;
        var populate = false;
        List<Detail>? details = null;
        foreach (var item in raw.Split(','))
        {
            var path = item.Trim();
            if (path.Length == 0) continue;
            if (Array.IndexOf(entity.PopulatablePaths, path) >= 0) populate = true;
            else (details ??= []).Add(new Detail("populate", $"Cannot populate: {path}"));
        }
        if (details is not null) throw new ApiError(400, details[0].Message, details);
        return populate;
    }

    /** `fields`: a mask of the selected fields (every field when absent). */
    public static int ParseFields(EntityDef entity, List<KeyValuePair<string, string>> query)
    {
        var raw = First(query, "fields");
        if (raw is null) return entity.AllFields;
        var mask = 0;
        var any = false;
        List<Detail>? details = null;
        HashSet<string>? reported = null;
        foreach (var item in raw.Split(','))
        {
            var name = item.Trim();
            if (name.Length == 0) continue;
            any = true;
            var field = entity.Find(name);
            if (field is not null) mask |= 1 << field.Bit;
            else if ((reported ??= []).Add(name)) (details ??= []).Add(new Detail("fields", $"Unknown field: {name}"));
        }
        if (!any) details = [new Detail("fields", "Must list at least one field")];
        if (details is not null) throw new ApiError(400, "Invalid query", details);
        return mask;
    }

    [GeneratedRegex(@"^where\[([^\]]+)\]\[([^\]]+)\](?:\[([^\]]+)\])?\z", RegexOptions.CultureInvariant)]
    private static partial Regex WhereKey();

    [GeneratedRegex(@"^-?\d+\z", RegexOptions.CultureInvariant)]
    private static partial Regex IntegerText();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex Iso8601();

    public static ListQuery ParseList(EntityDef entity, List<KeyValuePair<string, string>> query)
    {
        var details = new List<Detail>();
        var where = new List<Condition>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? sort = null, limit = null, offset = null;

        foreach (var (key, raw) in query)
        {
            if (!seen.Add(key))
            {
                details.Add(new Detail(key, "Parameter is repeated"));
                continue;
            }
            var match = key.StartsWith("where[", StringComparison.Ordinal) ? WhereKey().Match(key) : null;
            if (match is { Success: true })
            {
                var condition = ParseCondition(entity, match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Success ? match.Groups[3].Value : null, raw, key, details);
                if (condition is not null) where.Add(condition);
            }
            else if (key == "sort") sort = raw;
            else if (key == "limit") limit = raw;
            else if (key == "offset") offset = raw;
            else if (key is not ("fields" or "exclude" or "populate")) details.Add(new Detail(key, "Unknown parameter"));
        }

        var order = ParseSort(entity, sort, details);
        var limitValue = ParseInteger(limit, "limit", 1, MaxLimit, DefaultLimit, details);
        var offsetValue = ParseInteger(offset, "offset", 0, 9007199254740991, 0, details);
        if (details.Count > 0) throw new ApiError(400, "Invalid query", details);
        return new ListQuery(where, order, (int)limitValue, offsetValue);
    }

    private static Condition? ParseCondition(EntityDef entity, string name, string op, string? comparison, string raw, string param, List<Detail> details)
    {
        var field = entity.Find(name);
        if (field is null)
        {
            details.Add(new Detail(param, $"Field \"{name}\" cannot be filtered"));
            return null;
        }
        if (Array.IndexOf(FilterOperators, op) < 0)
        {
            details.Add(new Detail(param, $"Unknown operator \"{op}\""));
            return null;
        }
        if (Array.IndexOf(OperatorsFor(field.Type), op) < 0)
        {
            details.Add(new Detail(param, $"Operator \"{op}\" is not allowed for this field"));
            return null;
        }
        if (comparison is not null)
        {
            details.Add(new Detail(param, $"Unknown operator \"{op}\""));
            return null;
        }
        if (op is "in" or "nin")
        {
            var items = raw.Split(',').Select(item => item.Trim()).Where(item => item.Length > 0).ToArray();
            if (items.Length == 0)
            {
                details.Add(new Detail(param, "Must list at least one value"));
                return null;
            }
            if (items.Length > MaxListValues)
            {
                details.Add(new Detail(param, $"Must list at most {MaxListValues} values"));
                return null;
            }
            var before = details.Count;
            object value = field.Type switch
            {
                FieldType.Number => items.Select(item => ToNumber(item, param, details)).ToArray(),
                FieldType.Date => items.Select(item => ToDate(item, param, details)).ToArray(),
                _ => items.Select(item => ToText(field, item, param, details)).ToArray(),
            };
            return details.Count > before ? null : new Condition(field, op, value);
        }
        var count = details.Count;
        object single = field.Type switch
        {
            FieldType.Number => ToNumber(raw, param, details),
            FieldType.Date => ToDate(raw, param, details),
            _ => ToText(field, raw, param, details),
        };
        return details.Count > count ? null : new Condition(field, op, single);
    }

    private static double ToNumber(string raw, string param, List<Detail> details)
    {
        var text = raw.Trim();
        if (text.Length > 0 && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && double.IsFinite(value)) return value;
        details.Add(new Detail(param, "Must be a number"));
        return 0;
    }

    private static DateTime ToDate(string raw, string param, List<Detail> details)
    {
        if (Iso8601().IsMatch(raw) &&
            DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value))
            return value.UtcDateTime;
        details.Add(new Detail(param, "Must be an ISO 8601 date"));
        return default;
    }

    private static string ToText(FieldDef field, string raw, string param, List<Detail> details)
    {
        if (field.Type == FieldType.Enum && Array.IndexOf(field.Values!, raw) < 0)
            details.Add(new Detail(param, $"Must be one of: {string.Join(", ", field.Values!)}"));
        return raw;
    }

    private static List<SortItem> ParseSort(EntityDef entity, string? raw, List<Detail> details)
    {
        var sort = new List<SortItem>();
        if (raw is null)
        {
            sort.Add(new SortItem(entity.Find("createdAt")!, true));
        }
        else
        {
            foreach (var item in raw.Split(','))
            {
                var part = item.Trim();
                var descending = part.StartsWith('-');
                var name = descending ? part[1..] : part;
                var field = entity.Find(name);
                if (field is not { Sortable: true })
                {
                    details.Add(new Detail("sort", $"Field \"{name}\" cannot be sorted"));
                    continue;
                }
                if (sort.Exists(s => s.Field == field))
                {
                    details.Add(new Detail("sort", $"Field \"{name}\" is listed more than once"));
                    continue;
                }
                sort.Add(new SortItem(field, descending));
            }
        }
        if (!sort.Exists(s => s.Field.Name == "id")) sort.Add(new SortItem(entity.Find("id")!, true));
        return sort;
    }

    private static long ParseInteger(string? raw, string name, long min, long max, long fallback, List<Detail> details)
    {
        if (raw is null) return fallback;
        if (IntegerText().IsMatch(raw) && long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value) && value >= min && value <= max)
            return value;
        details.Add(new Detail(name, max == 9007199254740991 ? $"Must be an integer of at least {min}" : $"Must be an integer from {min} to {max}"));
        return fallback;
    }

    /** Appends ` WHERE ...` for the conditions, binding their values as positional parameters of `command`. */
    public static void AppendWhere(StringBuilder sql, List<Condition> where, NpgsqlBatchCommand command)
    {
        for (var i = 0; i < where.Count; i++)
        {
            var c = where[i];
            sql.Append(i == 0 ? " WHERE " : " AND ").Append(c.Field.Column);
            command.Parameters.Add(Parameter(c.Value));
            var n = command.Parameters.Count;
            sql.Append(c.Op switch
            {
                "eq" => " = $",
                "ne" => " <> $",
                "gt" => " > $",
                "gte" => " >= $",
                "lt" => " < $",
                "lte" => " <= $",
                "in" => " = ANY($",
                "nin" => " <> ALL($",
                _ => throw new InvalidOperationException(c.Op),
            }).Append(n);
            if (c.Op is "in" or "nin") sql.Append(')');
        }
    }

    public static void AppendOrder(StringBuilder sql, List<SortItem> sort, string prefix)
    {
        sql.Append(" ORDER BY ");
        for (var i = 0; i < sort.Count; i++)
        {
            if (i > 0) sql.Append(", ");
            sql.Append(prefix).Append(sort[i].Field.Column).Append(sort[i].Descending ? " DESC" : " ASC");
        }
    }

    public static void AppendPage(StringBuilder sql, ListQuery list, NpgsqlBatchCommand command)
    {
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = list.Limit });
        sql.Append(" LIMIT $").Append(command.Parameters.Count);
        command.Parameters.Add(new NpgsqlParameter<long> { TypedValue = list.Offset });
        sql.Append(" OFFSET $").Append(command.Parameters.Count);
    }

    public static NpgsqlParameter Parameter(object value) => value switch
    {
        string s => new NpgsqlParameter<string> { TypedValue = s },
        double d => new NpgsqlParameter<double> { TypedValue = d },
        DateTime t => new NpgsqlParameter<DateTime> { TypedValue = t },
        long l => new NpgsqlParameter<long> { TypedValue = l },
        int n => new NpgsqlParameter<int> { TypedValue = n },
        string[] a => new NpgsqlParameter<string[]> { TypedValue = a },
        double[] a => new NpgsqlParameter<double[]> { TypedValue = a },
        DateTime[] a => new NpgsqlParameter<DateTime[]> { TypedValue = a },
        _ => throw new ArgumentException(value.GetType().Name),
    };
}
