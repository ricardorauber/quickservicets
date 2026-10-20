"""Round 2: inclusive share of sampled JS time per component, as a Markdown table (one column per profile).

Usage: python3 inclusive-2.py name=path.cpuprofile [name=path.cpuprofile ...]
Same sample selection as inclusive.py (from the first request on, module loading skipped); the samples taken
during the graceful shutdown at the end of a run are dropped too.
"""
import json, sys

core = lambda f, name: f["url"].endswith(name)
GROUPS = {
  "core server: fetch + handle frames (synchronous parts only)": lambda f: f["functionName"] in ("fetch", "handle") and core(f, "/http/server.ts"),
  "toResponse (JSON.stringify + Response)": lambda f: f["functionName"] == "toResponse",
  "  JSON.stringify": lambda f: f["functionName"] == "stringify",
  "  of which Date toJSON / toISOString": lambda f: f["functionName"] in ("toJSON",),
  "  Response constructor": lambda f: f["functionName"] == "Response" and f["url"] in ("", "[native code]"),
  "Headers objects (new Headers / set)": lambda f: f["functionName"] == "Headers" or (f["functionName"] == "set" and f["url"] in ("", "[native code]")),
  "withHeader (x-request-id)": lambda f: f["functionName"] == "withHeader",
  "request logging (safeLog + end-of-turn flush)": lambda f: f["functionName"] in ("safeLog", "endOfTurn") and core(f, "/logger.ts"),
  "  stdout writeSync": lambda f: f["functionName"] == "writeSync",
  "new URL": lambda f: f["functionName"] == "URL" and f["url"] in ("", "[native code]"),
  "router.match": lambda f: f["functionName"] == "match" and core(f, "/http/router.ts"),
  "Bun.sql JS (internal:sql / bun:sql)": lambda f: f["url"].startswith("internal:sql") or f["url"].startswith("bun:sql"),
  "  checkUnsafeTransaction": lambda f: f["functionName"] == "checkUnsafeTransaction",
  "postgres adapter (postgres.ts + statements + conditions)": lambda f: any(core(f, n) for n in ("/adapters/postgres.ts", "/adapters/postgres-statements.ts", "/adapters/postgres-conditions.ts")),
  "  compileConditions": lambda f: f["functionName"] == "compileConditions",
  "  arrayLiteral (in-list parameter)": lambda f: f["functionName"] == "arrayLiteral",
  "fluent aggregate (aggregatesOf)": lambda f: f["functionName"] == "aggregatesOf",
  "  aggregateHandles": lambda f: f["functionName"] in ("aggregateHandles", "buildAggregateHandles"),
  "validateBody": lambda f: f["functionName"] == "validateBody",
  "splitRelations / writeRelations": lambda f: f["functionName"] in ("splitRelations", "writeRelations"),
  "readMultipart": lambda f: f["functionName"] == "readMultipart",
  "  ReadableStream reader (onRS*/onNativePull*)": lambda f: f["functionName"].startswith("onRS") or f["functionName"].startswith("onNativePull"),
  "  MultipartReader.push (copy into the body buffer)": lambda f: f["functionName"] == "push" and core(f, "/files/multipart.ts"),
  "resolveUploadType (detection + File copy)": lambda f: f["functionName"] == "resolveUploadType",
  "  detectFileType (Blob slice + arrayBuffer)": lambda f: f["functionName"] == "detectFileType",
  "  new File": lambda f: f["functionName"] == "File" and f["url"] in ("", "[native code]"),
  "storage put": lambda f: f["functionName"] == "put" and "/storage/" in f["url"],
  "  mkdir": lambda f: f["functionName"] == "mkdir",
}


def run(path):
    p = json.load(open(path))
    nodes = {n["id"]: n for n in p["nodes"]}
    parent = {}
    for n in p["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    counts = {g: 0 for g in GROUPS}
    total = 0
    started = False
    for s in p["samples"]:
        st = []
        nid = s
        while nid in nodes:
            st.append(nodes[nid]["callFrame"])
            nid = parent.get(nid)
        if not started:
            if any(fr["functionName"] in ("fetch", "handle") and fr["url"].endswith("/http/server.ts") for fr in st):
                started = True
            else:
                continue
        if any(fr["functionName"] in ("require", "(module)", "shutdown") or "mongodb/lib" in fr["url"] for fr in st):
            continue
        total += 1
        for g, t in GROUPS.items():
            if any(t(fr) for fr in st):
                counts[g] += 1
    return total, counts


pairs = [arg.split("=", 1) for arg in sys.argv[1:]]
names = [name for name, _ in pairs]
res = {name: run(path) for name, path in pairs}
print("| Inclusive % of sampled JS time | " + " | ".join(names) + " |")
print("| --- |" + " ---: |" * len(names))
for g in GROUPS:
    row = [100 * res[n][1][g] / res[n][0] for n in names]
    if max(row) < 0.5:
        continue
    print(f"| {g} | " + " | ".join(f"{v:.1f}" if v >= 0.05 else "–" for v in row) + " |")
print("| samples | " + " | ".join(str(res[n][0]) for n in names) + " |")
