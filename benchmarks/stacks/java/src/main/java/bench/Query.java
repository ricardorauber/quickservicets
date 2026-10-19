package bench;

import bench.ApiException.Detail;
import bench.Collection.Field;
import bench.Collection.Type;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses and validates the query parameters of the list and read routes, and turns them into SQL. */
public final class Query {
  private Query() {}

  /** A validated list query: the WHERE clause (empty or starting with " WHERE") with its arguments, and the paging. */
  public record ListQuery(String where, List<Object> args, String orderBy, int limit, long offset) {}

  public static final int DEFAULT_LIMIT = 20;
  public static final int MAX_LIMIT = 100;
  public static final int MAX_LIST_VALUES = 100;

  private static final Set<String> OPERATORS = Set.of(
      "eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull",
      "containsAny", "containsAll", "size", "isEmpty");
  private static final Set<String> COMMON = Set.of("eq", "ne", "in", "nin", "exists", "isNull");
  private static final Set<String> STRING_OPERATORS = union(COMMON, Set.of("contains", "startsWith"));
  private static final Set<String> ORDERED_OPERATORS = union(COMMON, Set.of("gt", "gte", "lt", "lte"));

  private static final Pattern WHERE_KEY = Pattern.compile("^where\\[([^\\]]+)\\]\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?$");
  private static final Pattern INTEGER = Pattern.compile("^-?\\d+$");
  private static final Pattern DECIMAL = Pattern.compile("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$");
  private static final Pattern ISO_8601 = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?$");

  private static Set<String> union(Set<String> a, Set<String> b) {
    Set<String> result = new LinkedHashSet<>(a);
    result.addAll(b);
    return Set.copyOf(result);
  }

  private static Set<String> operatorsOf(Type type) {
    return switch (type) {
      case STRING -> STRING_OPERATORS;
      case NUMBER, DATE -> ORDERED_OPERATORS;
      case ID, ENUM -> COMMON;
      case REF_ARRAY -> Set.of();
    };
  }

  private static String first(Map<String, String[]> params, String name) {
    String[] values = params.get(name);
    return values == null || values.length == 0 ? null : values[0];
  }

  private static List<String> splitList(String raw) {
    List<String> items = new ArrayList<>();
    for (String item : raw.split(",", -1)) {
      String trimmed = item.strip();
      if (!trimmed.isEmpty()) items.add(trimmed);
    }
    return items;
  }

  private static ApiException invalidQuery(List<Detail> details) {
    return new ApiException(400, "Invalid query", details);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // fields and populate

  /** The {@code fields} parameter: the selected top-level fields, or null to return every field. */
  public static List<String> fields(Map<String, String[]> params, Collection collection) {
    String raw = first(params, "fields");
    if (raw == null) return null;
    List<String> entries = splitList(raw);
    if (entries.isEmpty()) throw invalidQuery(List.of(new Detail("fields", "Must list at least one field")));
    List<String> selected = new ArrayList<>(new LinkedHashSet<>(entries));
    List<Detail> details = new ArrayList<>();
    for (String name : selected) {
      if (collection.field(name) == null) details.add(new Detail("fields", "Unknown field: " + name));
    }
    if (!details.isEmpty()) throw invalidQuery(details);
    return selected;
  }

  /** The {@code populate} parameter: whether the members are populated (the only reference of the API). */
  public static boolean populate(Map<String, String[]> params, Collection collection) {
    String raw = first(params, "populate");
    if (raw == null) return false;
    List<String> paths = new ArrayList<>(new LinkedHashSet<>(splitList(raw)));
    List<Detail> details = new ArrayList<>();
    for (String path : paths) {
      if (!collection.canPopulate(path)) details.add(new Detail("populate", "Cannot populate: " + path));
    }
    if (!details.isEmpty()) throw new ApiException(400, details.get(0).message(), details);
    return !paths.isEmpty();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // list queries

  public static ListQuery list(Map<String, String[]> params, Collection collection) {
    List<Detail> errors = new ArrayList<>();
    StringBuilder where = new StringBuilder();
    List<Object> args = new ArrayList<>();
    String sort = null;
    String limit = null;
    String offset = null;

    for (Map.Entry<String, String[]> entry : params.entrySet()) {
      String key = entry.getKey();
      String[] values = entry.getValue();
      for (int i = 1; i < values.length; i++) errors.add(new Detail(key, "Parameter is repeated"));
      String raw = values.length == 0 ? "" : values[0];
      Matcher match = WHERE_KEY.matcher(key);
      if (match.matches()) {
        condition(collection, match.group(1), match.group(2), match.group(3), raw, key, errors, where, args);
      } else if (key.equals("sort")) {
        sort = raw;
      } else if (key.equals("limit")) {
        limit = raw;
      } else if (key.equals("offset")) {
        offset = raw;
      } else if (!key.equals("fields") && !key.equals("populate")) {
        errors.add(new Detail(key, "Unknown parameter"));
      }
    }

    String orderBy = orderBy(sort, collection, errors);
    long limitValue = integer(limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors);
    long offsetValue = integer(offset, "offset", 0, Long.MAX_VALUE, 0, errors);
    if (!errors.isEmpty()) throw invalidQuery(errors);
    return new ListQuery(where.toString(), args, orderBy, (int) limitValue, offsetValue);
  }

  private static long integer(String raw, String name, long min, long max, long fallback, List<Detail> errors) {
    if (raw == null) return fallback;
    long value;
    try {
      value = INTEGER.matcher(raw).matches() ? Long.parseLong(raw) : Long.MIN_VALUE;
    } catch (NumberFormatException e) {
      value = Long.MIN_VALUE;
    }
    if (value < min || value > max) {
      errors.add(new Detail(name, max == Long.MAX_VALUE ? "Must be an integer of at least " + min : "Must be an integer from " + min + " to " + max));
      return fallback;
    }
    return value;
  }

  private static String orderBy(String raw, Collection collection, List<Detail> errors) {
    StringBuilder sql = new StringBuilder();
    Set<String> seen = new LinkedHashSet<>();
    if (raw == null) {
      sql.append("created_at DESC");
      seen.add("createdAt");
    } else {
      for (String item : raw.split(",", -1)) {
        String part = item.strip();
        boolean descending = part.startsWith("-");
        String name = descending ? part.substring(1) : part;
        Field field = collection.field(name);
        if (field == null || !field.isColumn()) {
          errors.add(new Detail("sort", "Field \"" + name + "\" cannot be sorted"));
          continue;
        }
        if (!seen.add(name)) {
          errors.add(new Detail("sort", "Field \"" + name + "\" is listed more than once"));
          continue;
        }
        if (!sql.isEmpty()) sql.append(", ");
        sql.append(field.column()).append(descending ? " DESC" : " ASC");
      }
    }
    // Tie-breaker: id descending, unless id is already part of the order.
    if (!seen.contains("id")) sql.append(sql.isEmpty() ? "" : ", ").append("id DESC");
    return sql.toString();
  }

  private static void condition(Collection collection, String name, String op, String comparison, String raw, String param,
                                List<Detail> errors, StringBuilder where, List<Object> args) {
    Field field = collection.field(name);
    if (field == null || !field.isColumn()) {
      errors.add(new Detail(param, "Field \"" + name + "\" cannot be filtered"));
      return;
    }
    if (!OPERATORS.contains(op)) {
      errors.add(new Detail(param, "Unknown operator \"" + op + "\""));
      return;
    }
    if (!operatorsOf(field.type()).contains(op)) {
      errors.add(new Detail(param, "Operator \"" + op + "\" is not allowed for this field"));
      return;
    }
    if (comparison != null) {
      errors.add(new Detail(param, "Unknown operator \"" + op + "\""));
      return;
    }
    String column = field.column();
    switch (op) {
      case "exists", "isNull" -> {
        if (!raw.equals("true") && !raw.equals("false")) {
          errors.add(new Detail(param, "Must be true or false"));
          return;
        }
        boolean isNull = op.equals("isNull") == raw.equals("true");
        append(where, column + (isNull ? " IS NULL" : " IS NOT NULL"));
      }
      case "in", "nin" -> {
        List<String> items = splitList(raw);
        if (items.isEmpty()) {
          errors.add(new Detail(param, "Must list at least one value"));
          return;
        }
        if (items.size() > MAX_LIST_VALUES) {
          errors.add(new Detail(param, "Must list at most " + MAX_LIST_VALUES + " values"));
          return;
        }
        int before = errors.size();
        List<Object> values = new ArrayList<>(items.size());
        for (String item : items) values.add(convert(item, field, param, errors));
        if (errors.size() > before) return;
        StringBuilder sql = new StringBuilder(column).append(op.equals("in") ? " IN (" : " NOT IN (");
        for (int i = 0; i < values.size(); i++) sql.append(i == 0 ? "?" : ", ?");
        append(where, sql.append(')').toString());
        args.addAll(values);
      }
      default -> {
        int before = errors.size();
        Object value = convert(raw, field, param, errors);
        if (errors.size() > before) return;
        switch (op) {
          case "contains" -> {
            append(where, column + " ILIKE ?");
            args.add("%" + escapeLike((String) value) + "%");
          }
          case "startsWith" -> {
            append(where, column + " ILIKE ?");
            args.add(escapeLike((String) value) + "%");
          }
          default -> {
            String operator = switch (op) {
              case "eq" -> " = ?";
              case "ne" -> " <> ?";
              case "gt" -> " > ?";
              case "gte" -> " >= ?";
              case "lt" -> " < ?";
              default -> " <= ?";
            };
            append(where, column + operator);
            args.add(value);
          }
        }
      }
    }
  }

  private static void append(StringBuilder where, String condition) {
    where.append(where.isEmpty() ? " WHERE " : " AND ").append(condition);
  }

  private static String escapeLike(String value) {
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
  }

  /** Converts one query string value to the field's type, adding an error when it does not fit. */
  private static Object convert(String raw, Field field, String param, List<Detail> errors) {
    switch (field.type()) {
      case NUMBER -> {
        String trimmed = raw.strip();
        if (DECIMAL.matcher(trimmed).matches()) {
          double value = Double.parseDouble(trimmed);
          if (Double.isFinite(value)) return value;
        }
        errors.add(new Detail(param, "Must be a number"));
        return null;
      }
      case DATE -> {
        OffsetDateTime value = ISO_8601.matcher(raw).matches() ? parseDate(raw) : null;
        if (value == null) errors.add(new Detail(param, "Must be an ISO 8601 date"));
        return value;
      }
      case ENUM -> {
        if (field.values().contains(raw)) return raw;
        errors.add(new Detail(param, "Must be one of: " + String.join(", ", field.values())));
        return null;
      }
      default -> {
        return raw;
      }
    }
  }

  /** An ISO 8601 date or date-time; without an offset, the time is UTC (the service's time zone). */
  private static OffsetDateTime parseDate(String raw) {
    try {
      if (raw.length() == 10) return LocalDate.parse(raw).atStartOfDay().atOffset(ZoneOffset.UTC);
      boolean hasOffset = raw.endsWith("Z") || raw.lastIndexOf('+') > 10 || raw.lastIndexOf('-') > 10;
      return OffsetDateTime.parse(hasOffset ? raw : raw + "Z", DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    } catch (DateTimeParseException e) {
      return null;
    }
  }
}
