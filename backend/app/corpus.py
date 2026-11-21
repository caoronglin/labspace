"""统一语料（Unified Corpus）。

门户内所有「可检索的东西」在这里汇总成一份可排序、可联想的索引：

* 服务目录（Go 核心导出的 catalog）—— 打开某台工具
* 植物生信数据库目录（databases.PLANT_DATABASES）—— 查某个库
* SnapOtter 文件处理工具（snapotter 工具目录）—— 找图片/PDF/音视频处理能力
* Linux 命令速查（commands 索引）—— 查命令用法

前端首页的命令面板（⌘K）、全局搜索的「本地」分组、搜索建议接口
都基于本模块，保证三处结果一致，不会出现「首页能搜到、搜索页搜不到」。
"""
from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from typing import Any

from .catalog import load_catalog
from .databases import PLANT_DATABASES

log = logging.getLogger("labspace.corpus")

# --------------------------------------------------------------------- 工具清单

#: 门户内页面（命令面板可直接跳转）
PAGES: list[dict[str, Any]] = [
    {"id": "/", "name": "首页工作台", "keywords": "首页 主页 工作台"},
    {"id": "/search", "name": "统一搜索", "keywords": "搜索 检索 searxng"},
    {"id": "/literature", "name": "科研文献检索", "keywords": "文献 pubmed 论文"},
    {"id": "/databases", "name": "植物数据库速查", "keywords": "植物 数据库 生信 tair kegg"},
    {"id": "/commands", "name": "Linux 命令速查", "keywords": "linux 命令 shell"},
    {"id": "/drawio", "name": "绘图工具", "keywords": "drawio 绘图 流程图"},
    {"id": "/drawings", "name": "我的图形", "keywords": "图形 存档"},
    {"id": "/genomes", "name": "公共基因组", "keywords": "genomes genome jbrowse 基因组 浏览器 变异 序列 fasta orf gc 生信工具 biotools"},
    {"id": "/bioinfo", "name": "生信实验实训", "keywords": "bioinfo 生信 实训 课程 实验 终端 作业 批阅 terminal"},
    {"id": "/translate", "name": "PDF 论文翻译", "keywords": "pdf 翻译 论文"},
    {"id": "/network", "name": "访问与诊断", "keywords": "网络 端口 诊断"},
    {"id": "/start", "name": "浏览器主页", "keywords": "主页 起始页 背景"},
    {"id": "/snapotter", "name": "文件工坊", "keywords": "snapotter 文件 图像 图片 pdf 音视频 转换 ocr 压缩 去背景"},
    {"id": "/files", "name": "文件管理", "keywords": "文件 网盘 共享 个人文件 公共基因组 公共质粒 回收站"},
    {"id": "/knowledge", "name": "知识库", "keywords": "知识库 文档 rag 笔记 检索"},
    {"id": "/workbench", "name": "个人工作台", "keywords": "工作台 任务 课题 指派 待办 日历 甘特"},
    {"id": "/colors", "name": "配色搭配", "keywords": "配色 色板 调色 取色 科研配色 nature science ggsci"},
    {"id": "/help", "name": "帮助中心", "keywords": "帮助 faq 文档 更新日志 上手"},
]

# --------------------------------------------------------------------- 语料构建

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+|[\u4e00-\u9fff]")

#: SnapOtter 工具分区 → 中文名（用于分组标题与展示）
_SECTION_CN: dict[str, str] = {
    "image": "图片处理",
    "pdf": "PDF 处理",
    "files": "文件处理",
    "video": "视频处理",
    "audio": "音频处理",
}

#: SnapOtter 工具中文别名（只收录常用能力，避免 243 个工具把搜索结果洗掉）
_TOOL_ALIASES: dict[str, str] = {
    # ---- 图片
    "image/compress": "图片 压缩 瘦身 减小体积",
    "image/resize": "图片 缩放 调整尺寸 放大 缩小",
    "image/crop": "图片 裁剪 剪切",
    "image/circle-crop": "图片 圆形裁剪 头像",
    "image/rounded-crop": "图片 圆角裁剪",
    "image/smart-crop": "图片 智能裁剪",
    "image/convert": "图片 格式转换 转码",
    "image/rotate": "图片 旋转 翻转",
    "image/watermark-image": "图片 水印",
    "image/watermark-text": "图片 文字水印 标注",
    "image/remove-background": "图片 抠图 去背景",
    "image/remove-gif-background": "动图 去背景 抠图",
    "image/ocr": "图片 文字识别 OCR 提取文字",
    "image/qr-generate": "二维码 生成",
    "image/barcode-generate": "条形码 生成",
    "image/barcode-read": "条形码 识别 读取",
    "image/blur-faces": "人脸 模糊 打码 隐私保护",
    "image/blur-background": "背景 模糊",
    "image/enhance-faces": "人脸 增强 美颜",
    "image/image-enhancement": "图片 增强 画质优化",
    "image/sharpening": "图片 锐化 变清晰",
    "image/pixelate": "图片 像素化 马赛克",
    "image/adjust-colors": "图片 调色 亮度 对比度 饱和度",
    "image/color-palette": "图片 取色 调色板 配色",
    "image/histogram": "图片 直方图 像素分布",
    "image/collage": "图片 拼图 拼接 网格",
    "image/compose": "图片 合成",
    "image/stitch": "图片 拼接 长图",
    "image/split": "图片 拆分 切割",
    "image/vectorize": "图片 矢量化 转SVG",
    "image/svg-to-raster": "SVG 光栅化 转位图",
    "image/upscale": "图片 超分辨率 放大 提升清晰度",
    "image/restore-photo": "老照片 修复 复原",
    "image/noise-removal": "图片 降噪 噪点",
    "image/meme-generator": "表情包 制作",
    "image/favicon": "网站图标 favicon",
    "image/html-to-image": "网页 截图 转图片",
    "image/info": "图片 信息 查看 尺寸",
    "image/bulk-rename": "图片 批量重命名",
    "image/find-duplicates": "图片 查重 重复检测",
    "image/image-to-base64": "图片 base64 编码",
    "image/image-to-pdf": "图片 转PDF",
    "image/duplicate-check": "图片 查重",
    # ---- PDF
    "pdf/merge-pdf": "PDF 合并 拼接",
    "pdf/split-pdf": "PDF 拆分 分割 分离",
    "pdf/compress-pdf": "PDF 压缩 减小体积",
    "pdf/ocr-pdf": "PDF OCR 扫描件 文字识别",
    "pdf/pdf-to-text": "PDF 转文本 提取文字",
    "pdf/pdf-to-image": "PDF 转图片",
    "pdf/pdf-to-jpg": "PDF 转JPG",
    "pdf/pdf-to-png": "PDF 转PNG",
    "pdf/pdf-to-word": "PDF 转Word 可编辑",
    "pdf/watermark-pdf": "PDF 水印",
    "pdf/rotate-pdf": "PDF 旋转 页面方向",
    "pdf/crop-pdf": "PDF 裁剪 页面",
    "pdf/protect-pdf": "PDF 加密 密码 保护",
    "pdf/unlock-pdf": "PDF 解密 去除密码",
    "pdf/redact-pdf": "PDF 涂黑 脱敏 遮盖 隐私",
    "pdf/extract-pages": "PDF 提取页面",
    "pdf/remove-pages": "PDF 删除页面",
    "pdf/organize-pdf": "PDF 整理 排序 页面重排",
    "pdf/sign-pdf": "PDF 签名 电子签章",
    "pdf/pdf-metadata": "PDF 元数据 信息",
    "pdf/pdf-page-numbers": "PDF 页码 添加",
    "pdf/grayscale-pdf": "PDF 灰度 黑白",
    "pdf/linearize-pdf": "PDF 网页优化 快速预览",
    "pdf/repair-pdf": "PDF 修复 损坏 恢复",
    "pdf/pdfa-convert": "PDF/A 归档 长期保存",
    "pdf/flatten-pdf": "PDF 扁平化",
    "pdf/booklet-pdf": "PDF 小册子 骑马订",
    "pdf/nup-pdf": "PDF 多页合一 拼版",
    # ---- 文件
    "files/create-zip": "打包 压缩 ZIP",
    "files/extract-zip": "解压 解包",
    "files/merge-csvs": "CSV 合并",
    "files/split-csv": "CSV 拆分",
    "files/csv-excel": "CSV 转Excel",
    "files/excel-to-csv": "Excel 转CSV",
    "files/csv-json": "CSV 转JSON",
    "files/json-xml": "JSON XML 互转",
    "files/yaml-json": "YAML JSON 互转",
    "files/markdown-to-docx": "Markdown 转Word",
    "files/markdown-to-pdf": "Markdown 转PDF",
    "files/markdown-to-html": "Markdown 转HTML",
    "files/html-to-pdf": "HTML 转PDF 网页存PDF",
    "files/word-to-pdf": "Word 转PDF",
    "files/excel-to-pdf": "Excel 转PDF",
    "files/powerpoint-to-pdf": "PPT 转PDF",
    "files/convert-document": "文档 转换",
    "files/convert-spreadsheet": "表格 转换",
    "files/convert-presentation": "演示文稿 转换",
    "files/chart-maker": "图表 制作",
    "files/epub-convert": "EPUB 转换 电子书",
    "files/to-epub": "转EPUB 电子书",
    # ---- 视频
    "video/compress-video": "视频 压缩 瘦身",
    "video/convert-video": "视频 格式转换 转码",
    "video/trim-video": "视频 剪切 截取",
    "video/merge-videos": "视频 合并 拼接",
    "video/extract-audio": "视频 提取音频",
    "video/video-to-gif": "视频 转GIF",
    "video/gif-to-video": "GIF 转视频",
    "video/video-to-frames": "视频 抽帧 提取帧",
    "video/images-to-video": "图片 合成视频",
    "video/auto-subtitles": "自动字幕 语音识别",
    "video/burn-subtitles": "字幕 烧录 嵌入",
    "video/extract-subtitles": "提取 字幕",
    "video/mute-video": "静音 去除声音",
    "video/resize-video": "视频 分辨率 缩放",
    "video/rotate-video": "视频 旋转",
    "video/reverse-video": "视频 倒放",
    "video/stabilize-video": "视频 防抖 稳定",
    "video/video-speed": "视频 变速 加速 慢放",
    "video/watermark-video": "视频 水印",
    "video/crop-video": "视频 裁剪",
    "video/change-fps": "帧率 FPS",
    "video/video-color": "视频 调色",
    "video/aspect-pad": "画面 比例 补边",
    "video/video-to-webp": "视频 转WebP",
    "video/replace-audio": "替换 音轨 配音",
    # ---- 音频
    "audio/convert-audio": "音频 格式转换 转码",
    "audio/trim-audio": "音频 剪切 截取",
    "audio/merge-audio": "音频 合并",
    "audio/split-audio": "音频 拆分",
    "audio/mp3-to-wav": "MP3 转WAV",
    "audio/wav-to-mp3": "WAV 转MP3",
    "audio/flac-to-mp3": "FLAC 转MP3",
    "audio/m4a-to-mp3": "M4A 转MP3",
    "audio/ogg-to-mp3": "OGG 转MP3",
    "audio/normalize-audio": "音频 响度 标准化 母带",
    "audio/noise-reduction": "音频 降噪",
    "audio/fade-audio": "音频 淡入 淡出",
    "audio/audio-speed": "音频 变速",
    "audio/pitch-shift": "音频 变调 音调",
    "audio/volume-adjust": "音频 音量 调整",
    "audio/reverse-audio": "音频 倒放",
    "audio/transcribe-audio": "语音转文字 听写 录音转写",
    "audio/silence-removal": "去除静音 静音裁剪",
    "audio/ringtone-maker": "铃声 制作",
    "audio/waveform-image": "波形图 音频可视化",
    "audio/audio-metadata": "音频 元数据 信息",
}


def _tokens(text: str) -> list[str]:
    """英文按词切分，中文逐字切分（支持「单细胞」这类无空格查询）。"""
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def _norm(text: str) -> str:
    return (text or "").strip().lower()


class CorpusEntry:
    """一条语料：type 决定前端如何渲染。"""

    __slots__ = ("type", "id", "title", "subtitle", "description", "url", "path", "keywords", "weight")

    def __init__(
        self,
        type: str,
        id: str,
        title: str,
        subtitle: str = "",
        description: str = "",
        url: str = "",
        path: str = "",
        keywords: str = "",
        weight: float = 1.0,
    ) -> None:
        self.type = type
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.url = url
        self.path = path
        self.keywords = keywords
        self.weight = weight

    def as_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "id": self.id,
            "title": self.title,
            "subtitle": self.subtitle,
            "description": self.description,
            "url": self.url,
            "path": self.path,
        }


def _load_commands() -> list[dict[str, Any]]:
    """Linux 命令索引（与 /api/commands 同源）。"""
    from .routers.docs import _load_cmd_index  # 延迟导入，避免循环依赖

    try:
        return list(_load_cmd_index().values())
    except Exception:  # noqa: BLE001 - 语料构建失败不应影响门户
        return []


def build_corpus(include_commands: bool = True) -> list[CorpusEntry]:
    """构建统一语料全集（服务 + 数据库 + 页面 + 工具 + 命令）。"""
    entries: list[CorpusEntry] = []

    for svc in load_catalog():
        if not svc.enabled:
            continue
        # 站内页面直接索引到页面本身，避免搜索结果先落到服务详情页
        path = svc.url if svc.url.startswith("/") else f"/services/{svc.id}"
        entries.append(
            CorpusEntry(
                type="service",
                id=svc.id,
                title=svc.name,
                subtitle=svc.description,
                description=svc.description,
                url=svc.url,
                path=path,
                keywords=" ".join(svc.tags),
                weight=1.4,
            )
        )

    for db_item in PLANT_DATABASES:
        # 中文名（cn）同时进入 keywords，使「临床变异」「药物化学」等中文别名可直接命中；
        # biomed 条目权重略低于植物库，避免新条目挤掉既有检索结果。
        keywords = " ".join(
            [*(db_item.get("tags", []) or []), db_item.get("cn", "") or "", db_item.get("category", "") or ""]
        )
        entries.append(
            CorpusEntry(
                type="database",
                id=db_item["id"],
                title=db_item["name"],
                subtitle=db_item.get("cn", ""),
                description=db_item.get("desc", ""),
                url=db_item["url"],
                path=f"/databases?q={db_item['name']}",
                keywords=keywords,
                weight=1.25 if db_item.get("featured") else (0.92 if db_item.get("biomed") else 1.0),
            )
        )

    for page in PAGES:
        entries.append(
            CorpusEntry(
                type="page",
                id=page["id"],
                title=page["name"],
                subtitle="门户页面",
                description=page["keywords"],
                path=page["id"],
                keywords=page["keywords"],
                weight=1.1,
            )
        )


    if include_commands:
        for cmd in _load_commands():
            name = cmd.get("name") or ""
            if not name:
                continue
            desc = cmd.get("desc") or ""
            entries.append(
                CorpusEntry(
                    type="command",
                    id=name,
                    title=name,
                    subtitle=desc[:60] or "Linux 命令",
                    description=desc[:200],
                    path=f"/commands?cmd={name}",
                    keywords=desc,
                    weight=0.9,
                )
            )

    # SnapOtter 文件处理工具（243+ 个），中文别名只覆盖常用能力
    try:
        from .snapotter import catalog_snapshot

        for t in catalog_snapshot():
            key = f"{t['section']}/{t['id']}"
            entries.append(
                CorpusEntry(
                    type="snapotter",
                    id=key,
                    title=t.get("name") or t["id"],
                    subtitle=_SECTION_CN.get(t["section"]) or t["section"],
                    description=(t.get("description") or "")[:200],
                    path=f"/snapotter?section={t['section']}&tool={t['id']}",
                    keywords=_TOOL_ALIASES.get(key, "") + " " + (t.get("accept") or ""),
                    weight=0.95,
                )
            )
    except Exception as exc:  # noqa: BLE001 - 语料构建失败不应影响门户
        # 不静默：语料是搜索的数据源，构建失败会让人以为"没有可搜的内容"。
        # 记一行日志，页面照常可用。
        log.warning("构建搜索语料失败：%s", exc)

    return entries


_CORPUS_CACHE: list[CorpusEntry] | None = None
_CORPUS_TS: float = 0.0


def corpus(refresh: bool = False) -> list[CorpusEntry]:
    """语料缓存（30 秒），避免每次搜索都重建命令索引。"""
    global _CORPUS_CACHE, _CORPUS_TS
    import time

    now = time.time()
    if refresh or _CORPUS_CACHE is None or now - _CORPUS_TS > 30:
        _CORPUS_CACHE = build_corpus()
        _CORPUS_TS = now
    return _CORPUS_CACHE


# --------------------------------------------------------------------- 检索


def _score(entry: CorpusEntry, kw: str, kw_tokens: list[str]) -> float:
    """命中打分：标题 > 副标题 > 关键词 > 描述；多关键词按 AND 收敛。"""
    title = _norm(entry.title)
    subtitle = _norm(entry.subtitle)
    keywords = _norm(entry.keywords)
    desc = _norm(entry.description)

    if not kw_tokens:
        return entry.weight

    # 全部关键词都要命中（中文逐字匹配，英文整词匹配）
    if not all(tok in title or tok in subtitle or tok in keywords or tok in desc for tok in kw_tokens):
        return 0.0

    score = entry.weight
    if title == kw:
        score += 6
    elif title.startswith(kw):
        score += 4.5
    elif kw in title:
        score += 3.2
    if kw in subtitle:
        score += 1.4
    if kw in keywords:
        score += 1.8
    if kw in desc:
        score += 0.6
    # 标题词级命中
    for tok in kw_tokens:
        if len(tok) > 1 and tok in title:
            score += 1.1
    return score


#: 单一类型最多返回多少条，避免某一类把结果洗掉（如 243 个文件工具）
TYPE_CAPS: dict[str, int] = {
    "snapotter": 4,
    "command": 5,
    "database": 10,
    "service": 5,
    "tool": 4,
    "page": 4,
}


def search_corpus(query: str, limit: int = 20, types: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """统一语料检索。返回按相关度排序的条目（单类型有数量上限）。"""
    kw = _norm(query)
    if not kw:
        return []
    kw_tokens = _tokens(query)
    type_filter = set(types) if types else None

    scored: list[tuple[float, CorpusEntry]] = []
    for entry in corpus():
        if type_filter and entry.type not in type_filter:
            continue
        s = _score(entry, kw, kw_tokens)
        if s > 0:
            scored.append((s, entry))

    scored.sort(key=lambda x: (-x[0], x[1].title))

    picked: list[dict[str, Any]] = []
    used: dict[str, int] = {}
    overflow: list[tuple[float, CorpusEntry]] = []
    for score, entry in scored:
        cap = TYPE_CAPS.get(entry.type)
        cnt = used.get(entry.type, 0)
        if cap is not None and cnt >= cap:
            overflow.append((score, entry))
            continue
        used[entry.type] = cnt + 1
        picked.append(entry.as_dict())
        if len(picked) >= limit:
            break

    if len(picked) < limit and overflow:
        for _, entry in overflow:
            picked.append(entry.as_dict())
            if len(picked) >= limit:
                break
    return picked


def suggest(query: str, limit: int = 10) -> list[str]:
    """搜索建议：基于语料标题、关键词与常用检索词。"""
    kw = _norm(query)
    out: list[str] = []
    seen: set[str] = set()

    if not kw:
        return [
            str(t.get("name") or t.get("title") or "")
            for t in PLANT_DATABASES
            if t.get("featured") and (t.get("name") or t.get("title"))
        ][:limit]

    for entry in corpus():
        if entry.title.lower() in seen:
            continue
        hay = f"{entry.title} {entry.subtitle} {entry.keywords}".lower()
        if kw and kw not in hay:
            continue
        seen.add(entry.title.lower())
        out.append(entry.title)
        if len(out) >= limit:
            break
    return out


#: 常用检索词（空查询时的「热搜」）
HOT_KEYWORDS: list[str] = [
    "单细胞",
    "拟南芥",
    "水稻",
    "转录组",
    "miRNA",
    "SNP",
    "KEGG",
    "TAIR",
    "GO 注释",
    "蛋白结构",
    "BioPython",
    "临床变异",
    "ChEMBL",
    "Linux 命令",
    "正则表达式",
]


def hot_keywords() -> list[str]:
    return list(HOT_KEYWORDS)
