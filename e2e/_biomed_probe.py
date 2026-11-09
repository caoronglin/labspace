"""逐个适配器真实查询并留证（输出 /opt/labspace/e2e/_biomed_probe.json）。"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, "/srv/app")

from app import db_apis  # noqa: E402

QUERIES = {
    "chembl": "aspirin",
    "pubchem": "aspirin",
    "clinvar": "BRCA1",
    "opentargets": "aspirin",
    "string-db": "TP53",
    "hpa": "TP53",
    "cellosaurus": "A549",
    "encode": "CTCF",
    "cbioportal": "breast",
    "openfda": "aspirin",
    "europepmc": "aspirin",
    "chebi": "glucose",
    "taxonomy": "Homo sapiens",
    "hgnc": "BRCA1",
    "pride": "proteome",
    "enrichr": "GO",
    "brain-atlas": "mouse",
}

OUT = "/tmp/_biomed_probe.json"


async def main() -> int:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    results = []
    for key, query in QUERIES.items():
        started = time.time()
        try:
            res = await db_apis.run_query(key, query, limit=5)
            ok = bool(res.get("ok")) and bool(res.get("items"))
            items = res.get("items") or []
            rec = {
                "key": key,
                "query": query,
                "ok": ok,
                "httpOk": bool(res.get("ok")),
                "count": len(items),
                "elapsedMs": res.get("elapsedMs", int((time.time() - started) * 1000)),
                "firstTitle": items[0].get("title", "") if items else "",
                "firstSource": items[0].get("source", "") if items else "",
                "error": res.get("error", ""),
            }
        except Exception as exc:  # noqa: BLE001
            rec = {
                "key": key, "query": query, "ok": False, "httpOk": False, "count": 0,
                "elapsedMs": int((time.time() - started) * 1000),
                "firstTitle": "", "firstSource": "",
                "error": f"{type(exc).__name__} {str(exc)[:200]}",
            }
        results.append(rec)
        print(f"{rec['key']:<14} ok={rec['ok']!s:<5} n={rec['count']:<3} "
              f"{rec['elapsedMs']:>5}ms  {rec['firstTitle'][:60]}  {rec['error'][:80]}")

    idx = db_apis.api_index()
    summary = db_apis.api_summary()
    has_api = [i for i in idx if i.get("hasApi")]
    missing_note = [i["id"] for i in idx if not i.get("hasApi") and not (i.get("note") or "").strip()]
    non_cn_note = [i["id"] for i in idx if not i.get("hasApi")
                   and not any("一" <= ch <= "鿿" for ch in (i.get("note") or ""))]

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "adapters": results,
        "allOk": all(r["ok"] for r in results),
        "failed": [r["key"] for r in results if not r["ok"]],
        "apiIndex": {
            "total": len(idx),
            "withApi": len(has_api),
            "withoutApi": len(idx) - len(has_api),
            "summaryTotal": summary.get("total"),
            "missingNote": missing_note,
            "nonChineseNote": non_cn_note,
        },
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print("---")
    print(json.dumps(payload["apiIndex"], ensure_ascii=False))
    print("WROTE", OUT)
    return 0 if payload["allOk"] else 1


sys.exit(asyncio.run(main()))
