package bench;

import bench.ApiException.Detail;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.Part;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MediaController {
  static final long MAX_SIZE = 1024 * 1024;
  private static final Set<String> ACCEPTED = Set.of("image/png", "image/jpeg");
  private static final Set<String> READ_ONLY = Set.of("id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url");
  private static final String COLUMNS = "id, created_at, updated_at, filename, mime_type, size";
  private static final Pattern CONTROL = Pattern.compile("[\\x00-\\x1f\\x7f]");
  private static final Pattern UNSAFE_IN_QUOTES = Pattern.compile("[\"\\\\\\x00-\\x1f]");

  private static final RowMapper<Map<String, Object>> ROW = (rs, n) -> {
    String id = rs.getString(1);
    return record(id, Values.timestamp(rs, 2), Values.timestamp(rs, 3), rs.getString(4), rs.getString(5), Values.number(rs.getDouble(6)));
  };

  private static Map<String, Object> record(String id, String createdAt, String updatedAt, String filename, String mimeType, Object size) {
    Map<String, Object> media = new LinkedHashMap<>(12);
    media.put("id", id);
    media.put("createdAt", createdAt);
    media.put("updatedAt", updatedAt);
    media.put("filename", filename);
    media.put("mimeType", mimeType);
    media.put("size", size);
    media.put("storage", "default");
    media.put("url", "/media/" + id + "/file");
    return media;
  }

  private final JdbcTemplate jdbc;
  private final Path uploadDir;

  public MediaController(JdbcTemplate jdbc, @Value("${app.upload-dir}") String uploadDir) {
    this.jdbc = jdbc;
    this.uploadDir = Path.of(uploadDir).toAbsolutePath();
  }

  @PostMapping("/media")
  public ResponseEntity<Map<String, Object>> upload(HttpServletRequest request) throws IOException, ServletException {
    String contentType = request.getContentType();
    if (contentType == null || !contentType.toLowerCase(Locale.ROOT).startsWith("multipart/form-data")) {
      throw new ApiException(415, "Must be multipart/form-data");
    }
    Part file = null;
    boolean sawFile = false;
    List<Part> others = new ArrayList<>();
    for (Part part : request.getParts()) {
      if (part.getName().equals("file")) {
        if (!sawFile) file = part.getSubmittedFileName() != null ? part : null;
        sawFile = true;
      } else {
        others.add(part);
      }
    }
    if (file == null) throw ApiException.invalidBody("file", "Is required");

    // The type: the detected one, unless the content is not recognized; a declared type must match it.
    byte[] head;
    try (InputStream in = file.getInputStream()) {
      head = in.readNBytes(FileTypes.HEAD_SIZE);
    }
    String detected = FileTypes.detect(head);
    String declared = essence(file.getContentType());
    String type;
    if (detected == null) {
      type = declared;
    } else if (declared.isEmpty() || declared.equals("application/octet-stream") || declared.equals(detected)) {
      type = detected;
    } else {
      throw new ApiException(415, "File content does not match its type",
          List.of(new Detail("file", "Detected " + detected + ", declared " + declared)));
    }
    long size = file.getSize();
    if (size > MAX_SIZE) throw new ApiException(413, "File too large");
    if (!ACCEPTED.contains(type)) throw ApiException.invalidBody("file", "File type not allowed");

    List<Detail> details = new ArrayList<>();
    List<String> seen = new ArrayList<>();
    for (Part part : others) {
      String name = part.getName();
      if (seen.contains(name)) continue;
      seen.add(name);
      details.add(new Detail(name, READ_ONLY.contains(name) ? "Field is read-only" : "Unknown field"));
    }
    if (!details.isEmpty()) throw ApiException.invalidBody(details);

    // Store the bytes, then insert the row; remove the file when the insert fails.
    String id = Uuid7.generate();
    String filename = sanitizeFilename(file.getSubmittedFileName());
    String storageKey = "media/" + id + "/" + Uuid7.generate() + extensionOf(filename);
    Path target = uploadDir.resolve(storageKey);
    Files.createDirectories(target.getParent());
    try (InputStream in = file.getInputStream()) {
      Files.copy(in, target);
    }
    OffsetDateTime now = Values.now();
    try {
      jdbc.update("INSERT INTO media (" + COLUMNS + ", storage, storage_key) VALUES (?, ?, ?, ?, ?, ?, 'default', ?)", ps -> {
        ps.setString(1, id);
        ps.setObject(2, now);
        ps.setObject(3, now);
        ps.setString(4, filename);
        ps.setString(5, type);
        ps.setDouble(6, size);
        ps.setString(7, storageKey);
      });
    } catch (RuntimeException e) {
      Files.deleteIfExists(target);
      throw e;
    }
    String timestamp = Values.iso(now);
    return ResponseEntity.status(HttpStatus.CREATED).body(record(id, timestamp, timestamp, filename, type, size));
  }

  @GetMapping("/media/{id}")
  public Map<String, Object> read(@PathVariable String id) {
    List<Map<String, Object>> rows = jdbc.query("SELECT " + COLUMNS + " FROM media WHERE id = ?", ROW, id);
    if (rows.isEmpty()) throw ApiException.notFound("Media not found");
    return rows.get(0);
  }

  private record StoredFile(String filename, String mimeType, long size, String storageKey) {}

  @GetMapping("/media/{id}/file")
  public void file(@PathVariable String id, HttpServletResponse response) throws IOException {
    List<StoredFile> rows = jdbc.query("SELECT filename, mime_type, size, storage_key FROM media WHERE id = ?",
        (rs, n) -> new StoredFile(rs.getString(1), rs.getString(2), (long) rs.getDouble(3), rs.getString(4)), id);
    if (rows.isEmpty()) throw ApiException.notFound("Media not found");
    StoredFile stored = rows.get(0);
    InputStream in;
    try {
      in = Files.newInputStream(uploadDir.resolve(stored.storageKey()));
    } catch (NoSuchFileException e) {
      throw ApiException.notFound("Media file not found");
    }
    try (in) {
      response.setStatus(200);
      response.setContentType(stored.mimeType());
      response.setContentLengthLong(stored.size());
      response.setHeader("Content-Disposition", "inline; filename=\"" + UNSAFE_IN_QUOTES.matcher(stored.filename()).replaceAll("") + "\"");
      OutputStream out = response.getOutputStream();
      in.transferTo(out);
    }
  }

  /** A MIME type without parameters, in lower case. */
  private static String essence(String type) {
    if (type == null) return "";
    int semicolon = type.indexOf(';');
    return (semicolon < 0 ? type : type.substring(0, semicolon)).strip().toLowerCase(Locale.ROOT);
  }

  /** The base name, without control characters, cut to 255 characters. */
  static String sanitizeFilename(String name) {
    int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    String base = CONTROL.matcher(name.substring(slash + 1)).replaceAll("");
    return base.length() > 255 ? base.substring(0, 255) : base;
  }

  /** The lowercased extension including the dot, or "" (also for names that start with their only dot). */
  static String extensionOf(String filename) {
    int dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.substring(dot).toLowerCase(Locale.ROOT) : "";
  }

  /** Signatures of the formats recognized by their content. */
  static final class FileTypes {
    static final int HEAD_SIZE = 64;

    private static final byte[] PNG = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
    private static final byte[] JPEG = {(byte) 0xff, (byte) 0xd8, (byte) 0xff};
    private static final byte[] GIF87A = ascii("GIF87a");
    private static final byte[] GIF89A = ascii("GIF89a");
    private static final byte[] RIFF = ascii("RIFF");
    private static final byte[] WEBP = ascii("WEBP");
    private static final byte[] PDF = ascii("%PDF-");
    private static final byte[] ID3 = ascii("ID3");

    private static byte[] ascii(String text) {
      return text.getBytes(StandardCharsets.US_ASCII);
    }

    private static boolean at(byte[] head, byte[] signature, int offset) {
      return head.length >= offset + signature.length
          && Arrays.equals(head, offset, offset + signature.length, signature, 0, signature.length);
    }

    static String detect(byte[] head) {
      if (at(head, PNG, 0)) return "image/png";
      if (at(head, JPEG, 0)) return "image/jpeg";
      if (at(head, GIF87A, 0) || at(head, GIF89A, 0)) return "image/gif";
      if (at(head, RIFF, 0) && at(head, WEBP, 8)) return "image/webp";
      if (at(head, PDF, 0)) return "application/pdf";
      if (at(head, ID3, 0)) return "audio/mpeg";
      return null;
    }
  }
}
