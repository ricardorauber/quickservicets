package bench;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The fields of a collection that list queries can filter, sort and select. */
public final class Collection {
  public enum Type { ID, STRING, NUMBER, DATE, ENUM, REF_ARRAY }

  /** A field; {@code column} is null for fields that are not a column of the table (reference arrays). */
  public record Field(String name, String column, Type type, List<String> values) {
    boolean isColumn() {
      return column != null;
    }
  }

  public static final List<String> ROLES = List.of("member", "admin");

  public static final Collection USERS = new Collection("users", List.of(
      new Field("id", "id", Type.ID, null),
      new Field("createdAt", "created_at", Type.DATE, null),
      new Field("updatedAt", "updated_at", Type.DATE, null),
      new Field("email", "email", Type.STRING, null),
      new Field("name", "name", Type.STRING, null),
      new Field("role", "role", Type.ENUM, ROLES),
      new Field("age", "age", Type.NUMBER, null)));

  public static final Collection ORGANIZATIONS = new Collection("organizations", List.of(
      new Field("id", "id", Type.ID, null),
      new Field("createdAt", "created_at", Type.DATE, null),
      new Field("updatedAt", "updated_at", Type.DATE, null),
      new Field("name", "name", Type.STRING, null),
      new Field("slug", "slug", Type.STRING, null),
      new Field("members", null, Type.REF_ARRAY, null)));

  private final String table;
  private final Map<String, Field> fields = new LinkedHashMap<>();

  private Collection(String table, List<Field> fields) {
    this.table = table;
    for (Field field : fields) this.fields.put(field.name(), field);
  }

  public String table() {
    return table;
  }

  public Field field(String name) {
    return fields.get(name);
  }

  /** Whether {@code populate} accepts the path: only reference arrays can be populated. */
  public boolean canPopulate(String path) {
    Field field = fields.get(path);
    return field != null && field.type() == Type.REF_ARRAY;
  }
}
