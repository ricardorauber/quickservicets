package bench;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  private static final Map<String, Boolean> OK = Map.of("ok", true);

  @GetMapping("/health")
  public Map<String, Boolean> health() {
    return OK;
  }
}
