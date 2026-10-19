"""Inclusive share of sampled JS time per framework component, as a Markdown table (one column per profile)."""
import json, glob, sys
GROUPS = {
  "request logging (safeLog)": lambda f: f["functionName"] == "safeLog",
  "  of which stdout write": lambda f: f["functionName"] == "writeFast",
  "drizzle SQL text build (toQuery)": lambda f: f["functionName"] in ("sqlToQuery",) and "drizzle" in f["url"],
  "any drizzle frame on the stack (incl. its Bun.sql calls)": lambda f: "drizzle-orm" in f["url"],
  "  drizzle insert build (buildInsertQuery)": lambda f: f["functionName"] == "buildInsertQuery",
  "  drizzle select build (buildSelectQuery)": lambda f: f["functionName"] == "buildSelectQuery",
  "drizzle row mapping (mapResultRow)": lambda f: f["functionName"] == "mapResultRow",
  "Bun.sql JS (internal:sql / bun:sql)": lambda f: f["url"].startswith("internal:sql") or f["url"].startswith("bun:sql"),
  "transactions (db.transaction)": lambda f: f["functionName"] in ("transaction",) ,
  "project() incl. structuredClone": lambda f: f["functionName"] == "project" and f["url"].endswith("projection.ts"),
  "  structuredClone": lambda f: f["functionName"] == "structuredClone",
  "selectFields (exposure + client fields)": lambda f: f["functionName"] == "selectFields",
  "presentPopulated": lambda f: f["functionName"] == "presentPopulated",
  "populateRecords": lambda f: f["functionName"] in ("populateRecords",),
  "loadRelations (junction)": lambda f: f["functionName"] == "loadRelations",
  "JSON.stringify of response (toResponse)": lambda f: f["functionName"] == "toResponse",
  "router.match": lambda f: f["functionName"] == "match" and f["url"].endswith("router.ts"),
  "parseListQuery": lambda f: f["functionName"] == "parseListQuery",
  "parseClientSelection": lambda f: f["functionName"] == "parseClientSelection",
  "validateBody": lambda f: f["functionName"] == "validateBody",
  "fluent fieldHandles": lambda f: f["functionName"] == "fieldHandles",
  "readMultipart": lambda f: f["functionName"] == "readMultipart",
  "  formData()": lambda f: f["functionName"] == "formData",
  "  declaredFileTypes (2nd scan)": lambda f: f["functionName"] == "declaredFileTypes",
  "resolveUploadType/detect": lambda f: f["functionName"] == "resolveUploadType",
  "storage put": lambda f: f["functionName"] == "put" and "/storage/" in f["url"],
  "withFileUrls": lambda f: f["functionName"] == "withFileUrls",
}
def run(path):
    p = json.load(open(path)); nodes = {n["id"]: n for n in p["nodes"]}; parent = {}
    for n in p["nodes"]:
        for c in n.get("children", []): parent[c] = n["id"]
    counts = {g: 0 for g in GROUPS}; total = 0; started = False
    for s in p["samples"]:
        st = []; nid = s
        while nid in nodes: st.append(nodes[nid]["callFrame"]); nid = parent.get(nid)
        if not started:
            if any(fr["functionName"] in ("fetch","handle") and fr["url"].endswith("/http/server.ts") for fr in st): started = True
            else: continue
        if any(fr["functionName"] in ("require","(module)") or "mongodb/lib" in fr["url"] for fr in st): continue
        total += 1
        for g, t in GROUPS.items():
            if any(t(fr) for fr in st): counts[g] += 1
    return total, counts
# Usage: python3 inclusive.py name=path.cpuprofile [name=path.cpuprofile ...]
pairs = [arg.split("=", 1) for arg in sys.argv[1:]]
names = [name for name, _ in pairs]
res = {name: run(path) for name, path in pairs}
print("| inclusive % of sampled JS time | " + " | ".join(names) + " |")
print("|---|" + "---:|" * len(names))
for g in GROUPS:
    row = [100 * res[n][1][g] / res[n][0] for n in names]
    if max(row) < 0.5: continue
    print(f"| {g} | " + " | ".join(f"{v:.1f}" if v >= 0.05 else "–" for v in row) + " |")
print("| samples | " + " | ".join(str(res[n][0]) for n in names) + " |")
