#!/usr/bin/env python3
"""LabOps 生信流水线执行器（宿主机 systemd 服务）。

后端只负责把 job.json 写入 /srv/labdata/labops/pipelines/<id>/，本进程按序领取、
调用 mamba 环境中的真实工具执行，并把状态写回 status.json / run.log。
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.getenv("LABOPS_PIPELINE_ROOT", "/srv/labdata/labops/pipelines"))
MAMBA_BIN = "/srv/labdata/bioinfo-training/shared/mamba/envs/bioinfo-base/bin"
SCANPY_PY = "/srv/labdata/labops/venvs/scanpy/bin/python"
BISMARK_BIN = "/srv/labdata/bioinfo-training/shared/mamba/envs/bismark/bin"
TIMEOUT = int(os.getenv("LABOPS_JOB_TIMEOUT", str(3 * 3600)))
POLL = float(os.getenv("LABOPS_POLL", "3"))

TOOLS = ["fastp", "fastqc", "multiqc", "minimap2", "samtools", "bwa-mem2", "hisat2", "bismark", "STAR", "salmon"]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def tool_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = f"{MAMBA_BIN}:{BISMARK_BIN}:{env.get('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')}"
    env.setdefault("TMPDIR", "/srv/labdata/labops/tmp")
    Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    return env


def which(name: str) -> str | None:
    return shutil.which(name, path=tool_env()["PATH"])


def write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


class Job:
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.work = folder / "work"
        self.spec = json.loads((folder / "job.json").read_text(encoding="utf-8"))
        self.log_path = folder / "run.log"
        self.log = self.log_path.open("a", encoding="utf-8", buffering=1)
        self.started = now()

    def line(self, text: str) -> None:
        self.log.write(f"[{datetime.now().strftime('%H:%M:%S')}] {text}\n")

    def status(self, status: str, progress: int, message: str, outputs: list[dict] | None = None) -> None:
        payload = {"status": status, "progress": max(0, min(100, int(progress))), "message": message,
                   "outputs": outputs or [], "started_at": self.started, "updated_at": now()}
        if status in ("succeeded", "failed", "cancelled"):
            payload["finished_at"] = now()
        write_json(self.folder / "status.json", payload)

    def cancelled(self) -> bool:
        return (self.folder / "cancel").exists()

    def run(self, cmd: list[str], cwd: Path | None = None) -> None:
        self.line("$ " + " ".join(cmd))
        if self.cancelled():
            raise RuntimeError("用户已取消")
        proc = subprocess.Popen(
            cmd, cwd=str(cwd or self.work), env=tool_env(),
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        started = time.monotonic()
        while proc.poll() is None:
            if self.cancelled():
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=20)
                raise RuntimeError("用户已取消")
            if time.monotonic() - started > TIMEOUT:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
                raise RuntimeError("执行超时")
            time.sleep(1)
        if proc.returncode != 0:
            raise RuntimeError(f"命令失败（退出码 {proc.returncode}）")

    def outputs(self) -> list[dict]:
        out: list[dict] = []
        for path in sorted(self.work.rglob("*")):
            if path.is_file() and path.stat().st_size > 0:
                out.append({"path": str(path.relative_to(self.work)), "size": path.stat().st_size})
        return out[:500]


def pair_inputs(inputs: list[str]) -> list[tuple[str, str | None]]:
    r1: dict[str, str] = {}
    r2: dict[str, str] = {}
    for path in inputs:
        name = Path(path).name
        if "_R1" in name or "_1." in name or name.endswith("_1.fastq.gz"):
            r1[name.replace("_R1", "_RX").replace("_1.", "_X.")] = path
        elif "_R2" in name or "_2." in name or name.endswith("_2.fastq.gz"):
            r2[name.replace("_R2", "_RX").replace("_2.", "_X.")] = path
        else:
            r1[f"__single__{name}"] = path
    pairs: list[tuple[str, str | None]] = []
    used = set()
    for key, path in r1.items():
        mate = r2.get(key)
        pairs.append((path, mate))
        if mate:
            used.add(key)
    for key, path in r2.items():
        if key not in used:
            pairs.append((path, None))
    return pairs


def fastq_inputs(job: Job) -> list[str]:
    return [p for p in job.spec.get("inputs", []) if p.lower().endswith((".fq", ".fastq", ".fq.gz", ".fastq.gz"))]


def pipeline_fastp_qc(job: Job) -> None:
    inputs = fastq_inputs(job)
    if not inputs:
        raise RuntimeError("未找到 FASTQ 输入")
    params = job.spec.get("params") or {}
    fastp = which("fastp") or "fastp"
    for idx, (r1, r2) in enumerate(pair_inputs(inputs)):
        job.status("running", 10 + idx * 40 // max(1, len(inputs)), f"fastp 处理 {Path(r1).name}")
        cmd = [fastp, "-i", r1, "-o", str(job.work / f"clean_{idx}_1.fq.gz"),
               "-j", str(job.work / f"fastp_{idx}.json"), "-h", str(job.work / f"fastp_{idx}.html")]
        if r2:
            cmd += ["-I", r2, "-O", str(job.work / f"clean_{idx}_2.fq.gz")]
        cmd += ["-l", str(int(params.get("min_length", 30))), "-q", str(int(params.get("qualified_quality", 20))),
                "-w", "4", "--detect_adapter_for_pe"]
        if params.get("adapter"):
            cmd += ["--adapter_sequence", str(params["adapter"])]
        job.run(cmd)
    multiqc = which("multiqc")
    if multiqc:
        job.status("running", 75, "MultiQC 汇总")
        job.run([multiqc, str(job.work), "-o", str(job.work / "multiqc"), "-f"])


def pipeline_fastqc(job: Job) -> None:
    inputs = fastq_inputs(job)
    if not inputs:
        raise RuntimeError("未找到 FASTQ 输入")
    job.status("running", 20, "FastQC 质控")
    job.run([which("fastqc") or "fastqc", "-t", "4", "--outdir", str(job.work), *inputs])
    multiqc = which("multiqc")
    if multiqc:
        job.status("running", 75, "MultiQC 汇总")
        job.run([multiqc, str(job.work), "-o", str(job.work / "multiqc"), "-f"])


def _samtools_sort(job: Job, prefix: str, align_cmd: list[str]) -> None:
    bam = job.work / f"{prefix}.sorted.bam"
    job.line("$ " + " ".join(align_cmd) + f" | samtools sort -@ 4 -o {bam}")
    env = tool_env()
    align = subprocess.Popen(align_cmd, cwd=str(job.work), env=env, stdout=subprocess.PIPE, stderr=job.log)
    sort = subprocess.Popen([which("samtools") or "samtools", "sort", "-@", "4", "-o", str(bam)],
                            cwd=str(job.work), env=env, stdin=align.stdout, stderr=job.log)
    assert align.stdout
    align.stdout.close()
    while sort.poll() is None:
        if job.cancelled():
            for p in (align, sort):
                try:
                    p.kill()
                except ProcessLookupError:
                    pass
            raise RuntimeError("用户已取消")
        time.sleep(1)
    align.wait()
    if align.returncode not in (0, None) or sort.returncode != 0:
        raise RuntimeError("比对或排序失败")
    job.run([which("samtools") or "samtools", "index", str(bam)])
    job.run([which("samtools") or "samtools", "flagstat", str(bam)], cwd=job.work)


def pipeline_minimap2_align(job: Job) -> None:
    inputs = fastq_inputs(job)
    ref = job.spec.get("reference")
    if not inputs or not ref:
        raise RuntimeError("缺少 FASTQ 或参考基因组")
    params = job.spec.get("params") or {}
    minimap2 = which("minimap2") or "minimap2"
    for idx, (r1, r2) in enumerate(pair_inputs(inputs)):
        job.status("running", 15 + idx * 50 // max(1, len(inputs)), f"minimap2 比对 {Path(r1).name}")
        cmd = [minimap2, "-ax", str(params.get("preset") or "map-ont"), "-t", str(int(params.get("threads", 4))), ref, r1]
        if r2:
            cmd.append(r2)
        _samtools_sort(job, f"align_{idx}", cmd)


def _make_bwa_index(job: Job, ref: str) -> None:
    if not Path(ref + ".bwt.2bit.64").exists() and not Path(ref + ".0123").exists():
        job.status("running", 8, "构建 bwa-mem2 索引")
        job.run([which("bwa-mem2") or "bwa-mem2", "index", ref])


def pipeline_bwa_align(job: Job) -> None:
    inputs = fastq_inputs(job)
    ref = job.spec.get("reference")
    if not inputs or not ref:
        raise RuntimeError("缺少 FASTQ 或参考基因组")
    _make_bwa_index(job, ref)
    params = job.spec.get("params") or {}
    for idx, (r1, r2) in enumerate(pair_inputs(inputs)):
        job.status("running", 20 + idx * 50 // max(1, len(inputs)), f"bwa-mem2 比对 {Path(r1).name}")
        cmd = [which("bwa-mem2") or "bwa-mem2", "mem", "-t", str(int(params.get("threads", 4))), ref, r1]
        if r2:
            cmd.append(r2)
        _samtools_sort(job, f"align_{idx}", cmd)


def pipeline_hisat2_align(job: Job) -> None:
    inputs = fastq_inputs(job)
    ref = job.spec.get("reference")
    if not inputs or not ref:
        raise RuntimeError("缺少 FASTQ 或参考基因组")
    index = job.work / "hisat2_index" / "genome"
    index.parent.mkdir(exist_ok=True)
    if not Path(str(index) + ".1.ht2").exists():
        job.status("running", 8, "构建 HISAT2 索引")
        job.run([which("hisat2-build") or "hisat2-build", "-p", "4", ref, str(index)])
    params = job.spec.get("params") or {}
    for idx, (r1, r2) in enumerate(pair_inputs(inputs)):
        job.status("running", 20 + idx * 50 // max(1, len(inputs)), f"HISAT2 比对 {Path(r1).name}")
        cmd = [which("hisat2") or "hisat2", "-p", str(int(params.get("threads", 4))), "-x", str(index)]
        cmd += ["-1", r1, "-2", r2] if r2 else ["-U", r1]
        _samtools_sort(job, f"align_{idx}", cmd)


def pipeline_bismark_align(job: Job) -> None:
    inputs = fastq_inputs(job)
    ref = job.spec.get("reference")
    if not inputs or not ref:
        raise RuntimeError("缺少 FASTQ 或参考基因组")
    bismark = which("bismark")
    if not bismark:
        raise RuntimeError("Bismark 尚未安装完成，请稍后重试")
    genome_dir = job.work / "bismark_genome"
    if not (genome_dir / "Bisulfite_Genome").is_dir():
        genome_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ref, genome_dir / "genome.fa")
        job.status("running", 8, "Bismark 基因组转化")
        job.run([which("bismark_genome_preparation") or "bismark_genome_preparation", "--bowtie2", str(genome_dir)],
                cwd=genome_dir)
    for idx, (r1, r2) in enumerate(pair_inputs(inputs)):
        job.status("running", 40 + idx * 40 // max(1, len(inputs)), f"Bismark 比对 {Path(r1).name}")
        cmd = [bismark, "--genome", str(genome_dir), "-p", "4", "-o", str(job.work)]
        cmd += ["-1", r1, "-2", r2] if r2 else [r1]
        job.run(cmd)


SCANPY_SCRIPT = r'''
import sys, json
from pathlib import Path
import scanpy as sc

src = Path(sys.argv[1]); out = Path(sys.argv[2])
kwargs = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
suffix = src.name.lower()
if suffix.endswith(".h5ad"):
    adata = sc.read_h5ad(src)
elif suffix.endswith(".h5"):
    adata = sc.read_10x_h5(src)
elif suffix.endswith(".mtx") or suffix.endswith(".mtx.gz"):
    adata = sc.read_10x_mtx(src.parent if src.is_file() else src)
elif suffix.endswith((".csv", ".tsv", ".txt")):
    adata = sc.read_csv(src, delimiter="\t" if suffix.endswith((".tsv", ".txt")) else ",")
else:
    raise SystemExit(f"不支持的矩阵格式: {src.name}")
sc.pp.filter_cells(adata, min_genes=int(kwargs.get("min_genes", 200)))
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.calculate_qc_metrics(adata, percent_top=None, log1p=True, inplace=True)
adata.raw = adata
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
adata = adata[:, adata.var.highly_variable].copy()
sc.pp.scale(adata, max_value=10)
sc.tl.pca(adata, svd_solver="arpack")
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=min(30, adata.obsm["X_pca"].shape[1]))
sc.tl.umap(adata)
try:
    sc.tl.leiden(adata, resolution=float(kwargs.get("resolution", 1.0)), flavor="igraph", n_iterations=2)
except Exception:
    from sklearn.cluster import KMeans
    k = max(2, min(10, adata.n_obs // 20 or 2))
    adata.obs["leiden"] = KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(adata.obsm["X_pca"][:, :10]).astype(str)
out.mkdir(parents=True, exist_ok=True)
adata.write_h5ad(out / "scanpy_result.h5ad")
adata.obs.to_csv(out / "cell_metadata.csv")
sc.pl.umap(adata, color="leiden", show=False)
import matplotlib.pyplot as plt
plt.savefig(out / "umap_leiden.png", dpi=150, bbox_inches="tight")
print(f"cells={adata.n_obs} genes={adata.n_vars}")
'''


def pipeline_scanpy_qc(job: Job) -> None:
    inputs = job.spec.get("inputs") or []
    if not inputs:
        raise RuntimeError("缺少表达矩阵输入")
    if not Path(SCANPY_PY).exists():
        raise RuntimeError("scanpy 环境尚未安装完成，请稍后重试")
    script = job.work / "run_scanpy.py"
    script.write_text(SCANPY_SCRIPT, encoding="utf-8")
    job.status("running", 20, "scanpy 质控与聚类")
    out = job.work / "output"
    job.run([SCANPY_PY, str(script), inputs[0], str(out), json.dumps(job.spec.get("params") or {})])


PIPELINES = {
    "fastp_qc": pipeline_fastp_qc,
    "fastqc": pipeline_fastqc,
    "minimap2_align": pipeline_minimap2_align,
    "bwa_align": pipeline_bwa_align,
    "hisat2_align": pipeline_hisat2_align,
    "bismark_align": pipeline_bismark_align,
    "scanpy_qc": pipeline_scanpy_qc,
}


def claim(folder: Path) -> bool:
    lock = folder / ".lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False


def process(folder: Path) -> None:
    job = Job(folder)
    try:
        job.status("running", 1, "开始执行")
        fn = PIPELINES.get(job.spec.get("pipeline", ""))
        if not fn:
            raise RuntimeError("未知流水线")
        fn(job)
        if job.cancelled():
            raise RuntimeError("用户已取消")
        job.status("succeeded", 100, "执行完成", job.outputs())
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        job.line("ERROR: " + message)
        job.line(traceback.format_exc())
        job.status("cancelled" if "取消" in message else "failed", 0, message, job.outputs())
    finally:
        job.log.close()
        (folder / ".lock").unlink(missing_ok=True)


def scan() -> None:
    for folder in sorted(ROOT.iterdir()):
        if not folder.is_dir():
            continue
        spec_path = folder / "job.json"
        if not spec_path.is_file() or (folder / "done").exists():
            continue
        status = {}
        try:
            status = json.loads((folder / "status.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if status.get("status") in ("succeeded", "failed", "cancelled"):
            (folder / "done").touch()
            continue
        if status.get("status") == "cancelling":
            # 任务已不在执行，直接落盘取消
            if not (folder / ".lock").exists():
                write_json(folder / "status.json", {"status": "cancelled", "progress": 0, "message": "已取消",
                                                    "outputs": [], "updated_at": now(), "finished_at": now()})
                (folder / "done").touch()
            continue
        if not claim(folder):
            continue
        process(folder)
        (folder / "done").touch()


def heartbeat(first: bool = False) -> None:
    tools = {name: which(name) for name in TOOLS}
    tools["scanpy"] = SCANPY_PY if Path(SCANPY_PY).exists() else None
    write_json(ROOT / "tools.json", {"tools": tools, "checked_at": now(),
                                     "env": {"mamba": MAMBA_BIN, "bismark": Path(BISMARK_BIN).is_dir()}})
    write_json(ROOT / "worker.json", {"pid": os.getpid(), "started_at": STARTED, "last_seen": now(),
                                      "first": first})


if __name__ == "__main__":
    STARTED = now()
    ROOT.mkdir(parents=True, exist_ok=True)
    heartbeat(True)
    last = time.monotonic()
    while True:
        try:
            scan()
        except Exception:  # noqa: BLE001
            print(traceback.format_exc(), file=sys.stderr, flush=True)
        if time.monotonic() - last > 20:
            try:
                heartbeat()
            except OSError:
                pass
            last = time.monotonic()
        time.sleep(POLL)