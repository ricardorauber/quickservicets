package bench;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import org.springframework.stereotype.Component;

/** Reads a JSON request body as an object, with the contract's errors for invalid JSON and non-objects. */
@Component
public class JsonBody {
  private final ObjectReader reader;

  public JsonBody(ObjectMapper mapper) {
    this.reader = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
  }

  public ObjectNode parse(byte[] body) {
    JsonNode node;
    try {
      node = body == null || body.length == 0 ? null : reader.readTree(body);
    } catch (IOException e) {
      node = null;
    }
    if (node == null || node.isMissingNode()) throw new ApiException(400, "Invalid JSON body");
    if (!(node instanceof ObjectNode object)) throw ApiException.invalidBody("", "Body must be a JSON object");
    return object;
  }
}
