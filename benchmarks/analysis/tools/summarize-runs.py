"""Summarizes runs of whatif-2/harness.sh: median req/s and CPU per request per variant of one tag.

Usage: python3 summarize-runs.py TAG results.txt
"""
import sys, re, statistics as st, collections
tag = sys.argv[1]
rows = []
for line in open(sys.argv[2]):
    m = re.match(r"(\S+) (\S+) (\S+):(\S+) (\d+) rps app_us=([\d.]+) pg_us=([\d.]+) err=([\d.]+)", line)
    if m and m.group(3) == tag:
        if float(m.group(8)) > 0.001: print('ERRORS:', line.strip()); continue
        rows.append((m.group(4), int(m.group(5)), float(m.group(6)), float(m.group(7))))
by = collections.defaultdict(list)
for r in rows: by[r[0]].append(r)
# ratio against the nearest base run in time
idx = {i: r for i, r in enumerate(rows)}
bases = [i for i, r in enumerate(rows) if r[0] == "base"]
ratios = collections.defaultdict(list)
for i, r in enumerate(rows):
    if not bases: break
    j = min(bases, key=lambda b: abs(b - i))
    b = rows[j]
    ratios[r[0]].append((r[1] / b[1], r[2] / b[2], r[3] / b[3]))
print(f"{'variant':45} {'n':>2} {'rps med':>8} {'rps max':>8} {'app_us med':>10} {'pg_us med':>9} {'rps/base':>8} {'app_us/base':>11}")
for v, rs in by.items():
    rr = ratios[v]
    print(f"{v:45} {len(rs):>2} {st.median(r[1] for r in rs):>8.0f} {max(r[1] for r in rs):>8} {st.median(r[2] for r in rs):>10.1f} {st.median(r[3] for r in rs):>9.1f} {st.median(x[0] for x in rr) if rr else 0:>8.3f} {st.median(x[1] for x in rr) if rr else 0:>11.3f}")
