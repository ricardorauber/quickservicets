package bench;

import bench.ApiException.Detail;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
  /** The columns of a user record, in the order {@link #ROW} reads them. */
  static final String COLUMNS = "id, created_at, updated_at, email, name, role, age";

  static final RowMapper<Map<String, Object>> ROW = (rs, n) -> user(rs, 1);

  /** Reads the seven user columns starting at {@code first}. */
  static Map<String, Object> user(ResultSet rs, int first) throws SQLException {
    Map<String, Object> user = new LinkedHashMap<>(10);
    user.put("id", rs.getString(first));
    user.put("createdAt", Values.timestamp(rs, first + 1));
    user.put("updatedAt", Values.timestamp(rs, first + 2));
    user.put("email", rs.getString(first + 3));
    user.put("name", rs.getString(first + 4));
    user.put("role", rs.getString(first + 5));
    user.put("age", Values.nullableNumber(rs, first + 6));
    return user;
  }

  /** Keeps only the selected fields (all of them when {@code fields} is null). */
  static Map<String, Object> select(Map<String, Object> record, List<String> fields) {
    if (fields == null) return record;
    Map<String, Object> selected = new LinkedHashMap<>(fields.size() * 2);
    for (String field : fields) selected.put(field, record.get(field));
    return selected;
  }

  static Map<String, Object> page(List<?> data, long total, Query.ListQuery query) {
    Map<String, Object> page = new LinkedHashMap<>(6);
    page.put("data", data);
    page.put("total", total);
    page.put("limit", query.limit());
    page.put("offset", query.offset());
    return page;
  }

  private final JdbcTemplate jdbc;
  private final JsonBody json;

  public UserController(JdbcTemplate jdbc, JsonBody json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  @GetMapping("/users")
  public Map<String, Object> list(HttpServletRequest request) {
    Map<String, String[]> params = request.getParameterMap();
    List<String> fields = Query.fields(params, Collection.USERS);
    Query.ListQuery query = Query.list(params, Collection.USERS);
    Query.populate(params, Collection.USERS);
    Object[] args = query.args().toArray();
    Long total = jdbc.queryForObject("SELECT count(*) FROM users" + query.where(), Long.class, args);
    List<Object> pageArgs = new ArrayList<>(query.args());
    pageArgs.add(query.limit());
    pageArgs.add(query.offset());
    List<Map<String, Object>> data = jdbc.query(
        "SELECT " + COLUMNS + " FROM users" + query.where() + " ORDER BY " + query.orderBy() + " LIMIT ? OFFSET ?",
        (rs, n) -> select(user(rs, 1), fields), pageArgs.toArray());
    return page(data, total, query);
  }

  @GetMapping("/users/{id}")
  public Map<String, Object> read(@PathVariable String id, HttpServletRequest request) {
    Map<String, String[]> params = request.getParameterMap();
    List<String> fields = Query.fields(params, Collection.USERS);
    Query.populate(params, Collection.USERS);
    List<Map<String, Object>> rows = jdbc.query("SELECT " + COLUMNS + " FROM users WHERE id = ?", ROW, id);
    if (rows.isEmpty()) throw ApiException.notFound("User not found");
    return select(rows.get(0), fields);
  }

  @PostMapping("/users")
  public ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) byte[] body) {
    UserInput input = validate(json.parse(body), true);
    String id = Uuid7.generate();
    OffsetDateTime now = Values.now();
    String role = input.role != null ? input.role : "member";
    try {
      jdbc.update("INSERT INTO users (" + COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?)", ps -> {
        ps.setString(1, id);
        ps.setObject(2, now);
        ps.setObject(3, now);
        ps.setString(4, input.email);
        ps.setString(5, input.name);
        ps.setString(6, role);
        if (input.age != null) ps.setDouble(7, input.age);
        else ps.setNull(7, Types.DOUBLE);
      });
    } catch (DuplicateKeyException e) {
      throw emailTaken();
    }
    Map<String, Object> user = new LinkedHashMap<>(10);
    user.put("id", id);
    user.put("createdAt", Values.iso(now));
    user.put("updatedAt", Values.iso(now));
    user.put("email", input.email);
    user.put("name", input.name);
    user.put("role", role);
    user.put("age", input.age == null ? null : Values.number(input.age));
    return ResponseEntity.status(HttpStatus.CREATED).body(user);
  }

  @PatchMapping("/users/{id}")
  public Map<String, Object> update(@PathVariable String id, @RequestBody(required = false) byte[] body) {
    UserInput input = validate(json.parse(body), false);
    StringBuilder sql = new StringBuilder("UPDATE users SET updated_at = ?");
    List<Object> args = new ArrayList<>(6);
    args.add(Values.now());
    if (input.email != null) {
      sql.append(", email = ?");
      args.add(input.email);
    }
    if (input.name != null) {
      sql.append(", name = ?");
      args.add(input.name);
    }
    if (input.role != null) {
      sql.append(", role = ?");
      args.add(input.role);
    }
    if (input.hasAge) {
      sql.append(", age = ?");
      args.add(input.age);
    }
    sql.append(" WHERE id = ? RETURNING ").append(COLUMNS);
    List<Map<String, Object>> rows;
    try {
      rows = jdbc.query(sql.toString(), ps -> {
        for (int i = 0; i < args.size(); i++) {
          Object arg = args.get(i);
          if (arg == null) ps.setNull(i + 1, Types.DOUBLE);
          else ps.setObject(i + 1, arg);
        }
        ps.setString(args.size() + 1, id);
      }, ROW);
    } catch (DuplicateKeyException e) {
      throw emailTaken();
    }
    if (rows.isEmpty()) throw ApiException.notFound("User not found");
    return rows.get(0);
  }

  @DeleteMapping("/users/{id}")
  public ResponseEntity<Void> delete(@PathVariable String id) {
    // One statement, so one transaction: delete the user (the junction rows cascade) and move the updatedAt of the
    // organizations that listed it. Every part of the statement sees the junction rows as they were before it.
    Long deleted = jdbc.queryForObject("""
        WITH deleted AS (DELETE FROM users WHERE id = ? RETURNING id),
        owners AS (
          UPDATE organizations SET updated_at = ?
          WHERE id IN (SELECT owner_id FROM organizations__members WHERE target_id IN (SELECT id FROM deleted))
        )
        SELECT count(*) FROM deleted""", Long.class, id, Values.now());
    if (deleted == null || deleted == 0) throw ApiException.notFound("User not found");
    return ResponseEntity.noContent().build();
  }

  private static ApiException emailTaken() {
    return new ApiException(409, "Value already exists", List.of(new Detail("email", "Value already exists")));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // body validation

  /** The validated fields of a body; null means absent (except {@code age}, see {@code hasAge}). */
  private static final class UserInput {
    String email;
    String name;
    String role;
    Double age;
    boolean hasAge;
  }

  /** JavaScript's \s, so that the email rule matches /^[^\s@]+@[^\s@]+\.[^\s@]+$/ exactly. */
  private static final String NOT_SPACE_OR_AT = "[^\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF@]";
  private static final Pattern EMAIL = Pattern.compile(NOT_SPACE_OR_AT + "+@" + NOT_SPACE_OR_AT + "+\\." + NOT_SPACE_OR_AT + "+");
  private static final Set<String> FIELDS = Set.of("email", "name", "role", "age");
  private static final Set<String> SYSTEM_FIELDS = Set.of("id", "createdAt", "updatedAt");

  private static UserInput validate(ObjectNode body, boolean create) {
    List<Detail> details = new ArrayList<>();
    UserInput input = new UserInput();

    JsonNode email = body.get("email");
    if (email == null) {
      if (create) details.add(new Detail("email", "Is required"));
    } else if (email.isNull()) {
      details.add(new Detail("email", "Cannot be null"));
    } else if (!email.isTextual()) {
      details.add(new Detail("email", "Must be a string"));
    } else if (!EMAIL.matcher(email.textValue()).matches()) {
      details.add(new Detail("email", "Must be a valid email"));
    } else {
      input.email = email.textValue();
    }

    JsonNode name = body.get("name");
    if (name == null) {
      if (create) details.add(new Detail("name", "Is required"));
    } else if (name.isNull()) {
      details.add(new Detail("name", "Cannot be null"));
    } else if (!name.isTextual()) {
      details.add(new Detail("name", "Must be a string"));
    } else if (name.textValue().isEmpty()) {
      details.add(new Detail("name", "Must be at least 1 characters"));
    } else if (name.textValue().length() > 100) {
      details.add(new Detail("name", "Must be at most 100 characters"));
    } else {
      input.name = name.textValue();
    }

    JsonNode role = body.get("role");
    if (role != null) {
      if (role.isNull()) details.add(new Detail("role", "Cannot be null"));
      else if (!role.isTextual() || !Collection.ROLES.contains(role.textValue())) details.add(new Detail("role", "Must be one of: member, admin"));
      else input.role = role.textValue();
    }

    JsonNode age = body.get("age");
    if (age != null) {
      input.hasAge = true;
      if (!age.isNull()) {
        double value = age.isNumber() ? age.doubleValue() : Double.NaN;
        if (!age.isNumber()) details.add(new Detail("age", "Must be a number"));
        else if (!Double.isFinite(value) || value != Math.rint(value)) details.add(new Detail("age", "Must be an integer"));
        else if (value < 0) details.add(new Detail("age", "Must be at least 0"));
        else if (value > 150) details.add(new Detail("age", "Must be at most 150"));
        else input.age = value;
      }
    }

    for (Iterator<String> names = body.fieldNames(); names.hasNext(); ) {
      String key = names.next();
      if (FIELDS.contains(key)) continue;
      details.add(new Detail(key, SYSTEM_FIELDS.contains(key) ? "Field is read-only" : "Unknown field"));
    }
    if (!details.isEmpty()) throw ApiException.invalidBody(details);
    return input;
  }
}
