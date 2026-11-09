#!/usr/bin/env python3
"""Plot Studio render worker (Python glue).

Invoked by the Go core as::

    /opt/labplot-venv/bin/python /opt/labspace/ops/plot_worker.py <jobdir>
    plot_worker.py --check           # JSON library availability

The worker only reads ``job.json`` / ``data.csv`` in ``jobdir`` and writes
``out/*`` plus ``status.json``. It never accepts code from the browser: the
chart type is an allow-listed template, data is plain CSV and parameters are
clamped. That keeps the agent-callable API usable without handing arbitrary
Python execution to a web request.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback
from pathlib import Path

CHART_IDS = (
    "bar", "line", "scatter", "box", "violin", "heatmap", "volcano",
    "venn", "tree", "circos", "manhattan", "pca", "gsea",
)

PALETTES = {
    "npg": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    "aaas": ["#3B4992", "#EE0000", "#008B45", "#631879", "#008280", "#BB0021", "#5F559B", "#A20056"],
    "lancet": ["#00468B", "#ED0000", "#42B540", "#0099B4", "#925E9F", "#FDAF91", "#AD002A", "#ADB6B6"],
    "nejm": ["#BC3C29", "#0072B5", "#E18727", "#20854E", "#7876B1", "#6F99AD", "#FFDC91", "#EE4C97"],
    "jama": ["#374E55", "#DF8F44", "#00A1D5", "#B24745", "#79AF97", "#6A6599", "#80796B"],
    "d3": ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD", "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF"],
    "set2": ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "okabe": ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#F0E442", "#56B4E9", "#E69F00", "#000000"],
    "ggplot": ["#F8766D", "#D89000", "#A3A500", "#39B600", "#00BF7D", "#00BFC4", "#00B0F6", "#9590FF", "#E76BF3"],
}


def _ete3():
    """ete3 still imports the stdlib ``cgi`` module removed in Python 3.13."""
    try:
        import cgi  # noqa: F401
    except ImportError:
        import html
        import types

        shim = types.ModuleType("cgi")
        shim.escape = html.escape
        shim.parse_header = lambda value: (value, {})
        sys.modules["cgi"] = shim
    import ete3

    return ete3


def _check() -> dict:
    libs = {}
    probes = {
        "matplotlib": lambda: __import__("matplotlib"),
        "seaborn": lambda: __import__("seaborn"),
        "pandas": lambda: __import__("pandas"),
        "numpy": lambda: __import__("numpy"),
        "scipy": lambda: __import__("scipy"),
        "matplotlib_venn": lambda: __import__("matplotlib_venn"),
        "ete3": _ete3,
        "pycircos": lambda: __import__("pycircos"),
        "gseapy": lambda: __import__("gseapy"),
        "Bio": lambda: __import__("Bio"),
        "jcvi": lambda: __import__("jcvi"),
        "bioinfokit": lambda: __import__("bioinfokit"),
    }
    for name, probe in probes.items():
        try:
            probe()
            libs[name] = True
        except Exception:  # noqa: BLE001 - availability probe
            libs[name] = False
    return {"ok": libs.get("matplotlib", False), "python": sys.executable, "libs": libs}


def _write_status(jobdir: Path, status: str, message: str = "", outputs=None, extra=None) -> None:
    payload = {"status": status, "message": message, "outputs": outputs or []}
    if extra:
        payload.update(extra)
    tmp = jobdir / "status.json.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(jobdir / "status.json")


def _palette(params: dict) -> list[str]:
    colors = params.get("colors")
    if isinstance(colors, list):
        clean = [str(c).strip() for c in colors if isinstance(c, str) and str(c).strip().startswith("#")]
        if clean:
            return clean
    return PALETTES.get(str(params.get("palette") or "npg"), PALETTES["npg"])


def _load_csv(jobdir: Path, params: dict):
    import pandas as pd

    path = jobdir / "data.csv"
    if not path.exists() or path.stat().st_size == 0:
        raise ValueError("没有输入数据：请粘贴 CSV 或选择示例数据")
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    first = raw.splitlines()[0] if raw.splitlines() else ""
    sep = "\t" if first.count("\t") > first.count(",") else ("," if "," in first else None)
    df = pd.read_csv(path, sep=sep, engine="python")
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _pick(df, *names):
    for n in names:
        if n and n in df.columns:
            return n
    return None


def _require_column(df, name: str, label: str):
    if not name or name not in df.columns:
        raise ValueError(f"数据缺少列「{label}」，可用列：{', '.join(map(str, df.columns[:12]))}")


def _style(plt, params: dict):
    plt.rcParams.update({
        "font.sans-serif": ["Noto Sans CJK SC", "Noto Sans CJK JP", "WenQuanYi Zen Hei", "DejaVu Sans"],
        "axes.unicode_minus": False,
        "figure.dpi": 120,
        "savefig.dpi": 300,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.titleweight": "bold",
    })
    width = float(params.get("width") or 7.2)
    height = float(params.get("height") or 4.8)
    return plt.subplots(figsize=(max(3.2, min(width, 20)), max(2.4, min(height, 20))))


def _save(fig, outdir: Path, stem: str, formats) -> list[dict]:
    outdir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for fmt in formats:
        path = outdir / f"{stem}.{fmt}"
        fig.savefig(path, format=fmt, bbox_inches="tight", facecolor="white")
        outputs.append({"path": str(path.relative_to(outdir.parent)), "size": path.stat().st_size})
    return outputs


def chart_bar(plt, sns, df, params, outdir):
    x = _pick(df, params.get("x"), df.columns[0])
    y = _pick(df, params.get("y"), df.columns[1] if len(df.columns) > 1 else None)
    group = _pick(df, params.get("group"))
    _require_column(df, x, "x")
    _require_column(df, y, "y")
    df = df[[c for c in (x, y, group) if c]].copy()
    df[y] = __import__("pandas").to_numeric(df[y], errors="coerce")
    df = df.dropna(subset=[y])
    agg = str(params.get("agg") or "mean")
    if group:
        data = df.groupby([x, group], dropna=False)[y].agg(agg if agg in ("sum", "mean", "median", "max", "min") else "mean").reset_index()
    else:
        data = df.groupby(x, dropna=False)[y].agg(agg if agg in ("sum", "mean", "median", "max", "min") else "mean").reset_index()
    fig, ax = _style(plt, params)
    colors = _palette(params)
    if bool(params.get("horizontal")):
        sns.barplot(data=data, y=x, x=y, hue=group, palette=colors, ax=ax, errorbar=None)
    else:
        sns.barplot(data=data, x=x, y=y, hue=group, palette=colors, ax=ax, errorbar=None)
    ax.set_title(str(params.get("title") or "柱状图"))
    if params.get("xlabel"):
        ax.set_xlabel(str(params["xlabel"]))
    if params.get("ylabel"):
        ax.set_ylabel(str(params["ylabel"]))
    if group:
        ax.legend(title=str(params.get("legend_title") or group), frameon=False)
    fig.tight_layout()
    return _save(fig, outdir, "bar", ("png", "svg", "pdf"))


def chart_line(plt, sns, df, params, outdir):
    x = _pick(df, params.get("x"), df.columns[0])
    y = _pick(df, params.get("y"), df.columns[1] if len(df.columns) > 1 else None)
    group = _pick(df, params.get("group"))
    _require_column(df, x, "x")
    _require_column(df, y, "y")
    fig, ax = _style(plt, params)
    colors = _palette(params)
    if group:
        sns.lineplot(data=df, x=x, y=y, hue=group, marker="o", palette=colors, ax=ax)
    else:
        sns.lineplot(data=df, x=x, y=y, marker="o", color=colors[0], ax=ax)
    ax.set_title(str(params.get("title") or "折线图"))
    fig.tight_layout()
    return _save(fig, outdir, "line", ("png", "svg", "pdf"))


def chart_scatter(plt, sns, df, params, outdir):
    x = _pick(df, params.get("x"), df.columns[0])
    y = _pick(df, params.get("y"), df.columns[1] if len(df.columns) > 1 else None)
    group = _pick(df, params.get("group"))
    size = _pick(df, params.get("size"))
    _require_column(df, x, "x")
    _require_column(df, y, "y")
    fig, ax = _style(plt, params)
    kwargs = {"data": df, "x": x, "y": y, "ax": ax, "alpha": 0.82, "edgecolor": "white", "linewidth": 0.4}
    if group:
        kwargs.update({"hue": group, "palette": _palette(params)})
        sns.scatterplot(**kwargs)
        ax.legend(frameon=False)
    else:
        sns.scatterplot(color=_palette(params)[0], **kwargs)
    if params.get("trendline"):
        try:
            sns.regplot(data=df, x=x, y=y, scatter=False, ax=ax, color="#64748b", line_kws={"linewidth": 1})
        except Exception:  # noqa: BLE001 - trendline is optional
            pass
    ax.set_title(str(params.get("title") or "散点图"))
    fig.tight_layout()
    return _save(fig, outdir, "scatter", ("png", "svg", "pdf"))


def chart_box(plt, sns, df, params, outdir, violin=False):
    x = _pick(df, params.get("x"), df.columns[0])
    y = _pick(df, params.get("y"), df.columns[1] if len(df.columns) > 1 else None)
    group = _pick(df, params.get("group"))
    _require_column(df, x, "x")
    _require_column(df, y, "y")
    fig, ax = _style(plt, params)
    colors = _palette(params)
    if violin:
        sns.violinplot(data=df, x=x, y=y, hue=group, palette=colors, inner="quart", cut=0, ax=ax)
    else:
        sns.boxplot(data=df, x=x, y=y, hue=group, palette=colors, width=0.6, ax=ax, fliersize=2)
    if params.get("points"):
        sns.stripplot(data=df, x=x, y=y, hue=group, dodge=bool(group), color="#334155", size=3, alpha=0.55, ax=ax)
    if group:
        ax.legend(frameon=False)
    ax.set_title(str(params.get("title") or ("小提琴图" if violin else "箱线图")))
    fig.tight_layout()
    return _save(fig, outdir, "violin" if violin else "box", ("png", "svg", "pdf"))


def chart_heatmap(plt, sns, df, params, outdir):
    import numpy as np
    import pandas as pd

    x, y, value = params.get("x"), params.get("y"), params.get("value")
    if x and y and value and all(c in df.columns for c in (x, y, value)):
        matrix = df.pivot_table(index=y, columns=x, values=value, aggfunc="mean")
    else:
        matrix = df.set_index(df.columns[0]) if df.columns[0] not in ("index",) else df
        matrix = matrix.select_dtypes(include=[np.number])
        if matrix.shape[1] == df.shape[1]:
            matrix = df.iloc[:, 1:].apply(pd.to_numeric, errors="coerce")
            matrix.index = df.iloc[:, 0]
    if matrix.empty or matrix.shape[0] < 2 or matrix.shape[1] < 2:
        raise ValueError("热图需要至少 2 行 2 列的数值矩阵")
    if bool(params.get("standardize")):
        matrix = matrix.sub(matrix.mean(axis=1), axis=0).div(matrix.std(axis=1).replace(0, 1), axis=0)
    fig, ax = _style(plt, params)
    max_rows = int(params.get("max_rows") or 80)
    if matrix.shape[0] > max_rows:
        matrix = matrix.iloc[:max_rows]
    cmap = str(params.get("cmap") or "RdBu_r")
    sns.heatmap(matrix, cmap=cmap, ax=ax, linewidths=0.3 if max(matrix.shape) < 40 else 0,
                cbar_kws={"shrink": 0.7}, xticklabels=True, yticklabels=True)
    ax.set_title(str(params.get("title") or "热图"))
    ax.tick_params(axis="x", labelrotation=45, labelsize=max(4, min(9, 220 // max(4, matrix.shape[1]))))
    fig.tight_layout()
    return _save(fig, outdir, "heatmap", ("png", "svg", "pdf"))


def chart_volcano(plt, sns, df, params, outdir):
    import numpy as np
    import pandas as pd

    gene = _pick(df, params.get("gene"), df.columns[0])
    lfc = _pick(df, params.get("x"), "log2fc", "log2FoldChange", "logFC", df.columns[1] if len(df.columns) > 1 else None)
    padj = _pick(df, params.get("y"), "padj", "pvalue", "p", df.columns[2] if len(df.columns) > 2 else None)
    _require_column(df, lfc, "log2FC")
    _require_column(df, padj, "p 值")
    d = df.copy()
    d[lfc] = pd.to_numeric(d[lfc], errors="coerce")
    d[padj] = pd.to_numeric(d[padj], errors="coerce").clip(lower=1e-300)
    d = d.dropna(subset=[lfc, padj])
    d["__score"] = -np.log10(d[padj])
    fc_cut = float(params.get("fc_cut") or 1.0)
    p_cut = float(params.get("p_cut") or 0.05)
    up = (d[lfc] >= fc_cut) & (d[padj] < p_cut)
    down = (d[lfc] <= -fc_cut) & (d[padj] < p_cut)
    fig, ax = _style(plt, params)
    ax.scatter(d.loc[~up & ~down, lfc], d.loc[~up & ~down, "__score"], s=16, c="#94a3b8", alpha=0.55, label="不显著", linewidths=0)
    ax.scatter(d.loc[up, lfc], d.loc[up, "__score"], s=22, c=_palette(params)[0], alpha=0.85, label=f"上调 {int(up.sum())}", linewidths=0)
    ax.scatter(d.loc[down, lfc], d.loc[down, "__score"], s=22, c="#2563eb", alpha=0.75, label=f"下调 {int(down.sum())}", linewidths=0)
    ax.axhline(-math.log10(p_cut), ls="--", lw=0.8, c="#cbd5e1")
    ax.axvline(fc_cut, ls="--", lw=0.8, c="#cbd5e1")
    ax.axvline(-fc_cut, ls="--", lw=0.8, c="#cbd5e1")
    labels = int(params.get("labels") or 8)
    if gene and labels > 0:
        top = d.loc[up | down].nlargest(labels, "__score")
        for _, row in top.iterrows():
            ax.annotate(str(row[gene])[:18], (row[lfc], row["__score"]), fontsize=6.5,
                        xytext=(3, 3), textcoords="offset points", color="#334155")
    ax.set_xlabel("log2 Fold Change")
    ax.set_ylabel("-log10(padj)")
    ax.set_title(str(params.get("title") or "火山图"))
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    return _save(fig, outdir, "volcano", ("png", "svg", "pdf"))


def chart_venn(plt, sns, df, params, outdir):
    from matplotlib_venn import venn2, venn3

    sets = params.get("sets")
    if not isinstance(sets, list):
        sets = [c for c in df.columns if df[c].isin([0, 1, "0", "1", True, False]).any()][:3]
    sets = [str(s) for s in sets if str(s) in df.columns][:4]
    if len(sets) < 2:
        raise ValueError("维恩图至少需要 2 个集合列（0/1 或布尔值）")
    members = []
    for s in sets[:3]:
        members.append(set(df.index[df[s].astype(str).isin(["1", "True", "true", "yes"])]))
    fig, ax = _style(plt, params)
    colors = _palette(params)
    if len(members) == 2:
        venn2(members, set_labels=sets[:2], ax=ax, set_colors=(colors[0], colors[1]), alpha=0.65)
    else:
        venn3(members, set_labels=sets[:3], ax=ax, set_colors=(colors[0], colors[1], colors[2]), alpha=0.65)
    ax.set_title(str(params.get("title") or "集合重叠"))
    fig.tight_layout()
    outputs = _save(fig, outdir, "venn", ("png", "svg", "pdf"))
    return outputs


def chart_tree(plt, sns, df, params, outdir):
    newick = str(params.get("newick") or "").strip()
    if not newick and "newick" in df.columns:
        newick = str(df["newick"].iloc[0])
    if not newick:
        raise ValueError("请提供 Newick 格式的树字符串")
    if not newick.endswith(";"):
        newick += ";"
    try:
        ete_tree = _ete3().Tree(newick)
        if len(ete_tree) < 2:
            raise ValueError("树至少需要 2 个叶节点")
    except ValueError:
        raise
    except Exception:  # noqa: BLE001 - ete3 is an optional validator
        pass
    from Bio import Phylo
    import io

    tree = Phylo.read(io.StringIO(newick), "newick")
    fig, ax = _style(plt, params)
    color = _palette(params)[0]
    try:
        Phylo.draw(tree, axes=ax, do_show=False, label_func=lambda c: c.name or "",
                   branch_labels=None, show_confidence=False,
                   label_colors={"support": color, "name": "#334155"})
    except TypeError:
        Phylo.draw(tree, axes=ax, do_show=False)
    for line in ax.get_lines():
        line.set_color("#334155")
        line.set_linewidth(1.1)
    ax.set_title(str(params.get("title") or "系统发育树"))
    ax.set_xlabel("分支长度")
    fig.tight_layout()
    return _save(fig, outdir, "tree", ("png", "svg", "pdf"))


def chart_circos(plt, sns, df, params, outdir):
    import numpy as np
    import pandas as pd

    chr_col = _pick(df, params.get("chr"), "chr", "chrom", "seqid", df.columns[0])
    start_col = _pick(df, params.get("start"), "start", df.columns[1] if len(df.columns) > 1 else None)
    end_col = _pick(df, params.get("end"), "end", df.columns[2] if len(df.columns) > 2 else None)
    val_col = _pick(df, params.get("value"), "value", df.columns[3] if len(df.columns) > 3 else None)
    _require_column(df, chr_col, "染色体")
    _require_column(df, val_col, "数值")
    d = df.copy()
    d[start_col] = pd.to_numeric(d.get(start_col, 0), errors="coerce").fillna(0)
    d[end_col] = pd.to_numeric(d.get(end_col, d[start_col]), errors="coerce").fillna(d[start_col])
    d[val_col] = pd.to_numeric(d[val_col], errors="coerce").fillna(0)
    chroms = list(d[chr_col].astype(str).drop_duplicates())
    chroms = chroms[: int(params.get("max_chroms") or 24)]
    d = d[d[chr_col].astype(str).isin(chroms)]
    if bool(params.get("pycircos")):
        try:
            return _circos_pycircos(d, chr_col, start_col, end_col, val_col, chroms, params, outdir)
        except Exception:  # noqa: BLE001 - fall back to the polar renderer
            pass
    fig, ax = _style(plt, params)
    ax.remove()
    ax = fig.add_subplot(111, projection="polar")
    colors = _palette(params)
    n = len(chroms)
    for i, chrom in enumerate(chroms):
        sub = d[d[chr_col].astype(str) == chrom]
        length = max(float(sub[end_col].max()), 1.0)
        theta = np.linspace(2 * np.pi * i / n, 2 * np.pi * (i + 0.78) / n, max(12, min(120, len(sub))))
        vals = np.interp(np.linspace(0, 1, len(theta)), np.linspace(0, 1, len(sub)), sub[val_col].to_numpy())
        height = 0.35 + 0.55 * (vals - np.nanmin(vals)) / max(np.nanmax(vals) - np.nanmin(vals), 1e-9)
        ax.bar(theta, height, width=(2 * np.pi / n) * 0.82 / len(theta), bottom=1.05,
               color=colors[i % len(colors)], alpha=0.85, linewidth=0)
        ax.text(2 * np.pi * (i + 0.39) / n, 1.78, chrom[:12], ha="center", va="center", fontsize=7)
    ax.set_ylim(0, 1.95)
    ax.set_axis_off()
    ax.set_title(str(params.get("title") or "Circos 基因组概览"), pad=18)
    fig.tight_layout()
    return _save(fig, outdir, "circos", ("png", "svg", "pdf"))


def _circos_pycircos(d, chr_col, start_col, end_col, val_col, chroms, params, outdir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from pycircos import Garc

    lengths = {c: int(max(d[d[chr_col].astype(str) == c][end_col].max(), 1000)) for c in chroms}
    fig = plt.figure(figsize=(6.4, 6.4), dpi=300)
    ax = fig.add_subplot(111)
    gcircle = Garc(ax=ax, size=max(lengths.values()) * 1.05)
    for i, (chrom, length) in enumerate(lengths.items()):
        gcircle.add_garc(chrom, (str(i * length), str(i * length + length)), length,
                         outer=0.75, inner=0.55, color="#e2e8f0")
    gcircle.set_garcs()
    colors = _palette(params)
    for i, chrom in enumerate(chroms):
        sub = d[d[chr_col].astype(str) == chrom]
        vals = sub[val_col].to_numpy(dtype=float)
        mid = (sub[start_col].to_numpy(dtype=float) + sub[end_col].to_numpy(dtype=float)) / 2
        for j, (pos, val) in enumerate(zip(mid, vals)):
            if j % max(1, len(sub) // 60):
                continue
            gcircle.plot_arcdata(chrom, (str(int(pos)), str(int(pos) + 1)), [float(val)],
                                 arc_color=colors[i % len(colors)], width=0.9)
    gcircle.savefig = False
    out = outdir / "circos.png"
    outdir.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return [{"path": "out/circos.png", "size": out.stat().st_size}]


def chart_manhattan(plt, sns, df, params, outdir):
    import numpy as np
    import pandas as pd

    chr_col = _pick(df, params.get("chr"), "chr", "chrom", df.columns[0])
    pos_col = _pick(df, params.get("pos"), "pos", "position", df.columns[1] if len(df.columns) > 1 else None)
    p_col = _pick(df, params.get("y"), "pvalue", "p", "padj", df.columns[2] if len(df.columns) > 2 else None)
    _require_column(df, chr_col, "染色体")
    _require_column(df, pos_col, "位置")
    _require_column(df, p_col, "p 值")
    d = df.copy()
    d[pos_col] = pd.to_numeric(d[pos_col], errors="coerce")
    d[p_col] = pd.to_numeric(d[p_col], errors="coerce").clip(lower=1e-300)
    d = d.dropna(subset=[pos_col, p_col])
    d["__logp"] = -np.log10(d[p_col])
    chroms = list(d[chr_col].astype(str).drop_duplicates())
    offset, ticks, labels = 0.0, [], []
    colors = _palette(params)
    fig, ax = _style(plt, params)
    for i, chrom in enumerate(chroms):
        sub = d[d[chr_col].astype(str) == chrom]
        ax.scatter(sub[pos_col] + offset, sub["__logp"], s=6, c=[colors[i % 2]], linewidths=0, alpha=0.8)
        ticks.append(offset + float(sub[pos_col].median()))
        labels.append(chrom)
        offset += float(sub[pos_col].max()) * 1.03
    cutoff = float(params.get("p_cut") or 5e-8)
    ax.axhline(-math.log10(cutoff), ls="--", lw=0.8, c="#dc2626")
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels, fontsize=7)
    ax.set_ylabel("-log10(p)")
    ax.set_title(str(params.get("title") or "曼哈顿图"))
    fig.tight_layout()
    return _save(fig, outdir, "manhattan", ("png", "svg", "pdf"))


def chart_pca(plt, sns, df, params, outdir):
    import numpy as np
    import pandas as pd

    group = _pick(df, params.get("group"), "group", "label")
    numeric = df.select_dtypes(include=[np.number]).copy()
    if group and group in df.columns:
        numeric = numeric.drop(columns=[group], errors="ignore")
    if numeric.shape[1] < 2 or numeric.shape[0] < 3:
        raise ValueError("PCA 需要至少 3 行样本、2 个数值特征")
    matrix = numeric.fillna(numeric.mean()).to_numpy(dtype=float)
    matrix = matrix - matrix.mean(axis=0)
    u, s, vt = np.linalg.svd(matrix, full_matrices=False)
    pc = u[:, :2] * s[:2]
    var = (s ** 2) / max((s ** 2).sum(), 1e-12) * 100
    fig, ax = _style(plt, params)
    labels = df[group].astype(str) if group and group in df.columns else pd.Series(["样本"] * len(df))
    colors = _palette(params)
    for i, lab in enumerate(labels.drop_duplicates()):
        mask = labels == lab
        ax.scatter(pc[mask, 0], pc[mask, 1], s=42, color=colors[i % len(colors)], label=lab, alpha=0.85, edgecolor="white")
    ax.axhline(0, lw=0.6, c="#e2e8f0")
    ax.axvline(0, lw=0.6, c="#e2e8f0")
    ax.set_xlabel(f"PC1 ({var[0]:.1f}%)")
    ax.set_ylabel(f"PC2 ({var[1]:.1f}%)")
    ax.set_title(str(params.get("title") or "主成分分析"))
    if labels.nunique() <= 12:
        ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    return _save(fig, outdir, "pca", ("png", "svg", "pdf"))


def chart_gsea(plt, sns, df, params, outdir):
    gmt = str(params.get("gmt") or "").strip()
    if not gmt:
        raise ValueError("GSEA 需要在参数 gmt 中提供基因集（GMT 内容）")
    import gseapy

    gene = _pick(df, params.get("gene"), "gene", df.columns[0])
    score = _pick(df, params.get("score"), "score", "log2fc", df.columns[1] if len(df.columns) > 1 else None)
    _require_column(df, gene, "基因")
    _require_column(df, score, "排序值")
    gmt_path = outdir.parent / "genesets.gmt"
    gmt_path.write_text(gmt, encoding="utf-8")
    rnk = df[[gene, score]].dropna()
    res = gseapy.prerank(rnk=rnk, gene_sets=str(gmt_path), outdir=str(outdir / "gsea"),
                         permutation_num=int(params.get("permutations") or 100), min_size=5,
                         max_size=int(params.get("max_size") or 500), seed=42, verbose=False)
    data = res.res2d
    data.to_csv(outdir / "gsea_result.csv", index=False)
    top = data.head(12).iloc[::-1]
    label = "Term" if "Term" in top.columns else top.columns[0]
    score_col = "NES" if "NES" in top.columns else top.columns[-1]
    fig, ax = _style(plt, params)
    colors = _palette(params)
    vals = __import__("pandas").to_numeric(top[score_col], errors="coerce").fillna(0)
    ax.barh(top[label].astype(str), vals, color=[colors[0] if v >= 0 else "#2563eb" for v in vals])
    ax.axvline(0, lw=0.8, c="#94a3b8")
    ax.set_xlabel(score_col)
    ax.set_title(str(params.get("title") or "GSEA 通路富集"))
    fig.tight_layout()
    outputs = _save(fig, outdir, "gsea", ("png", "svg", "pdf"))
    outputs.append({"path": "out/gsea_result.csv", "size": (outdir / "gsea_result.csv").stat().st_size})
    return outputs


HANDLERS = {
    "bar": chart_bar, "line": chart_line, "scatter": chart_scatter,
    "box": lambda *a: chart_box(*a, violin=False),
    "violin": lambda *a: chart_box(*a, violin=True),
    "heatmap": chart_heatmap, "volcano": chart_volcano, "venn": chart_venn,
    "tree": chart_tree, "circos": chart_circos, "manhattan": chart_manhattan,
    "pca": chart_pca, "gsea": chart_gsea,
}


def main() -> int:
    if "--check" in sys.argv:
        print(json.dumps(_check(), ensure_ascii=False))
        return 0
    if len(sys.argv) < 2:
        print("usage: plot_worker.py <jobdir> | --check", file=sys.stderr)
        return 2
    jobdir = Path(sys.argv[1]).resolve()
    job = json.loads((jobdir / "job.json").read_text(encoding="utf-8"))
    chart = str(job.get("chart") or "")
    params = job.get("params") if isinstance(job.get("params"), dict) else {}
    outdir = jobdir / "out"
    _write_status(jobdir, "running", f"正在渲染 {chart}")
    log = open(jobdir / "run.log", "a", encoding="utf-8")  # noqa: SIM115 - process lifetime

    def emit(msg: str) -> None:
        log.write(msg + "\n")
        log.flush()
        _write_status(jobdir, "running", msg[:180], extra={"log": msg[:400]})

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import seaborn as sns

        handler = HANDLERS.get(chart)
        if handler is None:
            raise ValueError(f"不支持的图表类型：{chart}")
        try:
            df = _load_csv(jobdir, params)
        except ValueError:
            # Newick alone is enough for a tree; a CSV is optional.
            if chart != "tree":
                raise
            import pandas as pd
            df = pd.DataFrame()
        emit(f"已载入 {len(df)} 行 × {len(df.columns)} 列，开始绘图")
        outputs = handler(plt, sns, df, params, outdir)
        plt.close("all")
        _write_status(jobdir, "succeeded", f"完成，共 {len(outputs)} 个输出", outputs)
        return 0
    except Exception as exc:  # noqa: BLE001 - report every failure to the UI
        tb = traceback.format_exc()
        log.write(tb + "\n")
        log.flush()
        _write_status(jobdir, "failed", str(exc)[:500])
        return 1
    finally:
        log.close()


if __name__ == "__main__":
    raise SystemExit(main())