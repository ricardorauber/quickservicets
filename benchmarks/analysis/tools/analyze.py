"""Summarizes a Bun .cpuprofile: samples per category (nearest categorized frame), top self and inclusive functions."""
import json, sys, glob, re, collections

RULES = [
    ("logging", lambda f, u: u.endswith("/logger.ts")),
    ("drizzle (SQL build + row mapping)", lambda f, u: "drizzle-orm" in u),
    ("Bun.sql driver (JS side)", lambda f, u: u.startswith("internal:sql") or u.startswith("bun:sql")),
    ("projection/selection (structuredClone)", lambda f, u: u.endswith("/projection.ts") or u.endswith("/http/selection.ts")),
    ("validation", lambda f, u: u.endswith("/validation.ts")),
    ("list query parsing", lambda f, u: u.endswith("/src/query.ts")),
    ("populate", lambda f, u: u.endswith("/populate.ts")),
    ("relations / referential integrity", lambda f, u: u.endswith("/relations.ts") or u.endswith("/referential-integrity.ts")),
    ("fluent query", lambda f, u: u.endswith("/fluent-query.ts")),
    ("postgres adapter + conditions", lambda f, u: u.endswith("/adapters/postgres.ts") or u.endswith("/sql/conditions.ts")),
    ("repository", lambda f, u: u.endswith("/repository.ts")),
    ("file access/url", lambda f, u: u.endswith("/files/access.ts")),
    ("multipart/upload", lambda f, u: "/files/" in u),
    ("storage", lambda f, u: "/storage/" in u),
    ("routing", lambda f, u: u.endswith("/http/router.ts")),
    ("hooks pipeline", lambda f, u: u.endswith("/http/pipeline.ts")),
    ("custom endpoint", lambda f, u: "/endpoints/" in u),
    ("crud handlers", lambda f, u: u.endswith("/http/crud.ts")),
    ("app wrappers", lambda f, u: u.endswith("/src/app.ts")),
    ("errors", lambda f, u: u.endswith("/errors.ts")),
    ("http server (core)", lambda f, u: u.endswith("/http/server.ts")),
]
INTERNAL = lambda f, u: u.startswith("node:") or u.startswith("internal:") or u.startswith("bun:")


def category(frame):
    f, u = frame["functionName"], frame["url"]
    for name, test in RULES:
        if test(f, u):
            return name
    return None


def label(frame):
    u = frame["url"]
    u = re.sub(r".*/node_modules/\.bun/[^/]+/node_modules/", "", u)
    u = u.replace("/app/packages/core/src/", "core/").replace("/app/benchmarks/quickservicets/", "qs/")
    return f'{frame["functionName"] or "(anon)"} {u}:{frame["lineNumber"]}' if u else frame["functionName"] or "(anon)"


def analyze(path, top=25):
    p = json.load(open(path))
    nodes = {n["id"]: n for n in p["nodes"]}
    parent = {}
    for n in p["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    cats = collections.Counter()
    self_c = collections.Counter()
    incl = collections.Counter()
    leafcat = collections.Counter()  # (category, leaf native fn) for natives
    total = 0
    started = False
    for s in p["samples"]:
        stack = []
        nid = s
        while nid in nodes:
            stack.append(nodes[nid]["callFrame"])
            nid = parent.get(nid)
        # Skip startup: count from the first sample inside the request handler.
        if not started:
            if any(fr["functionName"] in ("fetch", "handle") and fr["url"].endswith("/http/server.ts") for fr in stack):
                started = True
            else:
                continue
        if any(fr["functionName"] in ("require", "(module)") or "mongodb/lib" in fr["url"] for fr in stack):
            continue
        total += 1
        leaf = stack[0]
        self_c[label(leaf)] += 1
        for lbl in {label(fr) for fr in stack}:
            incl[lbl] += 1
        cat = None
        leafname = leaf["functionName"]
        # JSON.stringify of the response body is reported separately from the core server code.
        for fr in stack:
            cat = category(fr)
            if cat:
                break
        if cat == "http server (core)" and leafname == "stringify":
            cat = "JSON.stringify (response)"
        if cat is None and any(INTERNAL(fr["functionName"], fr["url"]) for fr in stack):
            cat = "node/bun internals (no framework frame)"
        if cat is None:
            cat = "native, no JS caller (event loop, I/O, GC)" if len(stack) <= 2 else "other/unattributed"
        cats[cat] += 1
        if not leaf["url"]:
            leafcat[(cat, leafname)] += 1
    out = []
    dur = (p["endTime"] - p["startTime"]) / 1e6
    out.append(f"# {path}\nsamples={total} wall={dur:.1f}s")
    out.append("\n## Categories (nearest categorized frame)")
    for c, n in cats.most_common():
        out.append(f"{100*n/total:5.1f}%  {c}")
    out.append("\n## Top self")
    for l, n in self_c.most_common(top):
        out.append(f"{100*n/total:5.1f}%  {l}")
    out.append("\n## Top inclusive")
    for l, n in incl.most_common(top + 15):
        out.append(f"{100*n/total:5.1f}%  {l}")
    out.append("\n## Native leaves by category")
    for (c, l), n in leafcat.most_common(25):
        out.append(f"{100*n/total:5.1f}%  {l}  <- {c}")
    return "\n".join(out)


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        for path in glob.glob(arg):
            print(analyze(path))
            print()
